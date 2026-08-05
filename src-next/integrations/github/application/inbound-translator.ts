import {
  createPullRequestService,
  type ObservePullRequest,
  type PullRequestService,
} from '../../../activities/index.js';
import {
  UlidIdGenerator,
  type CheckpointStore,
  type EventJournal,
  type IdGenerator,
} from '../../../kernel/index.js';
import type { OrchestrationService } from '../../../orchestration/index.js';
import type { ResourceLookup, ResourceService } from '../../../resources/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
  type ResourceId,
} from '../../../resources/index.js';
import type { WorkService } from '../../../work/index.js';
import { workItemId, type WorkItemId } from '../../../work/index.js';
import { admitObservedWork, type WorkAdmissionServices } from '../../application/work-admission.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { evaluateIntakeRules, type IntakeRule } from '../../contracts/intake-rules.js';
import type { WorkflowRouter } from '../../contracts/provider.js';
import type { GitHubIntakeRuleConfig } from '../contracts/config.js';
import type { ExternalWorkObservedPayload, GitHubAdapterEvent } from '../contracts/events.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';
import { commandContext } from './inbound-context.js';
import { applyReviewSignal } from './inbound-review-signals.js';
import { gitHubIntakeFacts, gitHubIntakeRules } from './intake-policy.js';
import { observePullRequest } from './pull-request-translation.js';

type InboundCommandCandidate =
  | {
      readonly kind: 'discover-resource';
      readonly resourceId: ResourceId;
      readonly externalKey: { readonly adapter: AdapterId; readonly key: string };
      readonly revision: string;
    }
  | {
      readonly kind: 'create-work-item';
      readonly workItemId: WorkItemId;
      readonly objective: string;
    }
  | {
      readonly kind: 'correlate-resource';
      readonly resourceId: ResourceId;
      readonly workItemId: WorkItemId;
    }
  | { readonly kind: 'pr.observe'; readonly input: ObservePullRequest };

interface InboundTranslatorDependencies {
  readonly pullRequests?: PullRequestService;
  readonly ids?: IdGenerator;
  readonly lookup?: ResourceLookup;
  readonly adapter?: AdapterId;
  readonly orchestration?: OrchestrationService;
  readonly routing?: WorkflowRouter;
  readonly intake?: readonly GitHubIntakeRuleConfig[];
}

export class InboundTranslator {
  private readonly minted = new Map<string, { resourceId: ResourceId; workItemId: WorkItemId }>();

  translate(payload: ExternalWorkObservedPayload): readonly InboundCommandCandidate[] {
    const { resourceId: resourceIdValue, workItemId: workItemIdValue } = this.newIdentity({
      adapter: this.adapter,
      key: payload.externalKey,
    });
    const commands: InboundCommandCandidate[] = [
      {
        kind: 'discover-resource',
        resourceId: resourceIdValue,
        externalKey: { adapter: this.adapter, key: payload.externalKey },
        revision: payload.revision,
      },
      { kind: 'create-work-item', workItemId: workItemIdValue, objective: payload.title },
      { kind: 'correlate-resource', resourceId: resourceIdValue, workItemId: workItemIdValue },
    ];
    if (payload.kind === 'pull-request') {
      commands.push({
        kind: 'pr.observe',
        input: observePullRequest(resourceIdValue, workItemIdValue, payload),
      });
    }
    return commands;
  }

  constructor(
    private readonly journal?: EventJournal,
    private readonly checkpoints?: CheckpointStore,
    private readonly work?: WorkService,
    private readonly resources?: ResourceService,
    dependencies: InboundTranslatorDependencies = {},
  ) {
    this.pullRequests = dependencies.pullRequests;
    this.ids = dependencies.ids ?? new UlidIdGenerator();
    this.lookup = dependencies.lookup;
    this.adapter = dependencies.adapter ?? GitHubAdapter;
    this.orchestration = dependencies.orchestration;
    this.routing = dependencies.routing;
    this.intake = gitHubIntakeRules(dependencies.intake ?? []);
  }

  private readonly pullRequests: PullRequestService | undefined;
  private readonly ids: IdGenerator;
  private readonly lookup: ResourceLookup | undefined;
  private readonly adapter: AdapterId;
  private readonly orchestration: OrchestrationService | undefined;
  private readonly routing: WorkflowRouter | undefined;
  private readonly intake: readonly IntakeRule[];

  // Adapter filtering, checkpointing, and typed event dispatch must stay together.
  // eslint-disable-next-line complexity
  async runOnce(limit = 100): Promise<void> {
    if (
      this.journal === undefined ||
      this.checkpoints === undefined ||
      this.work === undefined ||
      this.resources === undefined
    ) {
      throw new Error('InboundTranslator services are required to run evidence translation');
    }
    const checkpoint = `reactor:integration.${this.adapter}.inbound`;
    const position = await this.checkpoints.load(checkpoint);
    const events = await this.journal.readAll(position, limit);
    for (const event of events) {
      const owned = selectGitHubAdapterEvent(event);
      if (owned?.stream.id === this.adapter && owned.eventType === GitHubEventType.WorkObserved)
        await this.apply(owned);
      if (owned?.stream.id === this.adapter && owned.eventType === GitHubEventType.CommentObserved)
        await applyReviewSignal({
          event: owned,
          journal: this.journal,
          resources: this.resources,
          work: this.work,
          lookup: this.lookup,
          pullRequests: this.pullRequests,
          ids: this.ids,
          adapter: this.adapter,
          orchestration: this.orchestration,
        });
      await this.checkpoints.save(checkpoint, event.globalPosition);
    }
  }

  private async apply(
    event: Extract<GitHubAdapterEvent, { eventType: typeof GitHubEventType.WorkObserved }>,
  ): Promise<void> {
    if (this.work === undefined || this.resources === undefined) return;
    const payload = event.payload;
    const context = commandContext(event);
    const pullRequests =
      this.pullRequests ?? createPullRequestService(this.journal!, this.work, this.resources);
    const intake = evaluateIntakeRules(this.intake, gitHubIntakeFacts(payload));
    const identity = await this.resolveIdentity(
      { adapter: this.adapter, key: payload.externalKey },
      intake.admitted,
    );
    if (identity === null) return;
    if (!identity.created) {
      const current = await this.resources.get(identity.resourceId);
      if (current === null) throw new Error(`Resource ${identity.resourceId} could not be loaded`);
      if (current.revision !== payload.revision) {
        await this.resources.discover(
          {
            resourceId: current.resourceId,
            kind: current.kind,
            externalKey: current.externalKey,
            capabilities: current.capabilities,
            revision: payload.revision,
            ...(current.title === undefined ? {} : { title: current.title }),
          },
          context,
        );
      }
      if (payload.kind === 'pull-request')
        await pullRequests.observe(
          observePullRequest(current.resourceId, identity.workItemId, payload),
          context,
        );
      return;
    }
    const { resourceId: resourceIdValue, workItemId: workItemIdValue } = identity;
    const isPullRequest = payload.kind === 'pull-request';
    await admitObservedWork(
      this.admissionServices(),
      {
        adapter: this.adapter,
        resourceId: resourceIdValue,
        workItemId: workItemIdValue,
        kind: isPullRequest ? BuiltInResourceKind.PullRequest : BuiltInResourceKind.Issue,
        externalKey: { adapter: this.adapter, key: payload.externalKey },
        capabilities: isPullRequest
          ? [
              BuiltInResourceCapability.Commentable,
              BuiltInResourceCapability.Reviewable,
              BuiltInResourceCapability.Revisioned,
            ]
          : [BuiltInResourceCapability.Commentable],
        objective: payload.title,
        tags: intake.tags,
        revision: payload.revision,
        title: payload.title,
      },
      context,
      isPullRequest
        ? async () => {
            await pullRequests.observe(
              observePullRequest(resourceIdValue, workItemIdValue, payload),
              context,
            );
          }
        : undefined,
    );
  }

  private mintIdentity(externalKey: { readonly adapter: string; readonly key: string }) {
    const key = `${externalKey.adapter}:${externalKey.key}`;
    const existing = this.minted.get(key);
    if (existing !== undefined) return existing;
    const identity = this.newIdentity(externalKey);
    this.minted.set(key, identity);
    return identity;
  }

  private newIdentity(_externalKey: { readonly adapter: string; readonly key: string }) {
    return {
      resourceId: resourceId(this.ids.next('resource')),
      workItemId: workItemId(this.ids.next('work')),
    };
  }

  private admissionServices(): WorkAdmissionServices {
    if (
      this.work === undefined ||
      this.resources === undefined ||
      this.orchestration === undefined ||
      this.routing === undefined
    )
      throw new Error('InboundTranslator requires work, resources, orchestration, and routing');
    return {
      work: this.work,
      resources: this.resources,
      orchestration: this.orchestration,
      routing: this.routing,
    };
  }

  private async resolveIdentity(
    externalKey: { readonly adapter: string; readonly key: string },
    admitted: boolean,
  ) {
    const key = `${externalKey.adapter}:${externalKey.key}`;
    const inBatch = this.minted.get(key);
    if (inBatch !== undefined) return { ...inBatch, created: false };
    if (this.lookup === undefined) throw new Error('InboundTranslator lookup is required');
    const resourceIdValue = await this.lookup.resourceIdForExternalKey(externalKey);
    if (resourceIdValue !== null) {
      if (this.resources === undefined) throw new Error('InboundTranslator resources are required');
      const correlation = (await this.resources.correlations(resourceIdValue)).find(
        (value) => value.role === ResourceCorrelationRole.Primary,
      );
      if (correlation === undefined)
        throw new Error(`Resource ${resourceIdValue} has no primary WorkItem correlation`);
      const identity = { resourceId: resourceIdValue, workItemId: correlation.workItemId };
      this.minted.set(key, identity);
      return { ...identity, created: false };
    }
    // An ineligible object Wake has never seen produces no WorkItem, Run, or effect.
    if (!admitted) return null;
    return { ...this.mintIdentity(externalKey), created: true };
  }
}
