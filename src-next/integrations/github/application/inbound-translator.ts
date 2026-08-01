import {
  correlationId,
  EventActorKind,
  UlidIdGenerator,
  type CheckpointStore,
  type CommandContext,
  type EventJournal,
  type IdGenerator,
} from '../../../kernel/index.js';
import {
  createPullRequestService,
  ReviewDecisionKind,
  type ObservePullRequest,
  type PullRequestService,
} from '../../../activities/index.js';
import type { ResourceLookup, ResourceService } from '../../../resources/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  resourceId,
  type ResourceId,
} from '../../../resources/index.js';
import type { WorkService } from '../../../work/index.js';
import { workItemId, type WorkItemId } from '../../../work/index.js';
import type { ExternalWorkObservedPayload, GitHubAdapterEvent } from '../contracts/events.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';
import { UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { observePullRequest } from './pull-request-translation.js';
import { translateGitHubReviewCommand } from './review-command-translator.js';

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
  }

  private readonly pullRequests: PullRequestService | undefined;
  private readonly ids: IdGenerator;
  private readonly lookup: ResourceLookup | undefined;
  private readonly adapter: AdapterId;

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
        await this.applyReviewSignal(owned);
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
    const identity = await this.resolveIdentity({
      adapter: this.adapter,
      key: payload.externalKey,
    });
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
    await this.resources.discover(
      {
        resourceId: resourceIdValue,
        kind:
          payload.kind === 'pull-request'
            ? BuiltInResourceKind.PullRequest
            : BuiltInResourceKind.Issue,
        externalKey: { adapter: this.adapter, key: payload.externalKey },
        capabilities:
          payload.kind === 'pull-request'
            ? [
                BuiltInResourceCapability.Commentable,
                BuiltInResourceCapability.Reviewable,
                BuiltInResourceCapability.Revisioned,
              ]
            : [BuiltInResourceCapability.Commentable],
        revision: payload.revision,
      },
      context,
    );
    await this.work.create({ workItemId: workItemIdValue, objective: payload.title }, context);
    await this.resources.correlate(resourceIdValue, workItemIdValue, 'primary', context);
    if (payload.kind === 'pull-request')
      await pullRequests.observe(
        observePullRequest(resourceIdValue, workItemIdValue, payload),
        context,
      );
  }

  private async applyReviewSignal(
    event: Extract<GitHubAdapterEvent, { eventType: typeof GitHubEventType.CommentObserved }>,
  ): Promise<void> {
    if (this.journal === undefined || this.resources === undefined || this.work === undefined)
      return;
    const payload = event.payload;
    if (this.lookup === undefined) throw new Error('InboundTranslator lookup is required');
    let resourceIdValue = await this.lookup.resourceIdForExternalKey({
      adapter: this.adapter,
      key: payload.externalKey,
    });
    if (resourceIdValue === null) resourceIdValue = resourceId(this.ids.next('resource'));
    const proposed = translateGitHubReviewCommand({
      resourceId: resourceIdValue,
      revision: payload.revision,
      actorId: payload.actor.id,
      actorKind: payload.actor.kind,
      resourceAuthorId: payload.resourceAuthorId ?? UnknownGitHubIdentity,
      authorization: payload.authorization ?? { source: 'none' },
      providerEventId: event.eventId,
      body: payload.body,
    });
    if (proposed === null) return;
    const context = commandContext(event);
    const pullRequests =
      this.pullRequests ?? createPullRequestService(this.journal, this.work, this.resources);
    if (proposed.kind === ReviewDecisionKind.Accepted)
      await pullRequests.acceptReviewSignal(
        { ...proposed, acceptedEventId: proposed.providerEventId },
        context,
      );
    else
      await pullRequests.requestChangesSignal(
        { ...proposed, requestedEventId: proposed.providerEventId },
        context,
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

  private async resolveIdentity(externalKey: { readonly adapter: string; readonly key: string }) {
    const key = `${externalKey.adapter}:${externalKey.key}`;
    const inBatch = this.minted.get(key);
    if (inBatch !== undefined) return { ...inBatch, created: false };
    if (this.lookup === undefined) throw new Error('InboundTranslator lookup is required');
    const resourceIdValue = await this.lookup.resourceIdForExternalKey(externalKey);
    if (resourceIdValue !== null) {
      if (this.resources === undefined) throw new Error('InboundTranslator resources are required');
      const correlation = (await this.resources.correlations(resourceIdValue)).find(
        (value) => value.role === 'primary',
      );
      if (correlation === undefined)
        throw new Error(`Resource ${resourceIdValue} has no primary WorkItem correlation`);
      const identity = { resourceId: resourceIdValue, workItemId: correlation.workItemId };
      this.minted.set(key, identity);
      return { ...identity, created: false };
    }
    return { ...this.mintIdentity(externalKey), created: true };
  }
}

function commandContext(event: GitHubAdapterEvent): CommandContext {
  return {
    commandId: `${event.eventId}:inbound`,
    correlationId: correlationId(event.correlationId),
    occurredAt: event.occurredAt,
    actor: { kind: EventActorKind.Integration, id: 'github' },
  };
}
