/* eslint-disable max-lines */
import {
  ActivityEventType,
  createPullRequestService,
  type ObservePullRequest,
  type PullRequestService,
} from '../../../activities/index.js';
import type { RunRepository } from '../../../execution/index.js';
import {
  correlationId,
  createEventDraft,
  EventActorKind,
  EventSourceKind,
  UlidIdGenerator,
  WrongExpectedSequenceError,
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
  ResourceEventType,
  resourceId,
  resourceStream,
  type ResourceId,
} from '../../../resources/index.js';
import type { WorkService } from '../../../work/index.js';
import { conversationIdForWorkItem, type ConversationService } from '../../../conversations/index.js';
import { workItemId, type WorkItemId } from '../../../work/index.js';
import { admitObservedWork, type WorkAdmissionServices } from '../../application/work-admission.js';
import { concludeObservedWork } from '../../application/work-conclusion.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { evaluateIntakeRules, type IntakeRule } from '../../contracts/intake-rules.js';
import type { WorkConclusion, WorkflowRouter } from '../../contracts/provider.js';
import { deliveryStream, integrationStream } from '../../contracts/streams.js';
import { DeliveryEventType, selectDeliveryEvent } from '../../delivery/contracts/events.js';
import type { GitHubIntakeRuleConfig } from '../contracts/config.js';
import type { ExternalWorkObservedPayload, GitHubAdapterEvent } from '../contracts/events.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';
import { commandContext } from './inbound-context.js';
import { applyReviewSignal } from './inbound-review-signals.js';
import { applyWatchGateVerdictSignal } from './inbound-watch-gate-signals.js';
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

type ResolvedIdentity = {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId | null;
  readonly created: boolean;
  readonly deleted: boolean;
  readonly missingPrimary?: true;
};

interface InboundTranslatorDependencies {
  readonly pullRequests?: PullRequestService;
  readonly ids?: IdGenerator;
  readonly lookup?: ResourceLookup;
  readonly adapter?: AdapterId;
  readonly orchestration?: OrchestrationService;
  readonly runs?: RunRepository;
  readonly routing?: WorkflowRouter;
  readonly intake?: readonly GitHubIntakeRuleConfig[];
  readonly conclusion?: WorkConclusion;
  readonly conversations?: ConversationService;
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
    this.runs = dependencies.runs;
    this.routing = dependencies.routing;
    this.intake = gitHubIntakeRules(dependencies.intake ?? []);
    this.conclusion = dependencies.conclusion;
    this.conversations = dependencies.conversations;
  }

  private readonly pullRequests: PullRequestService | undefined;
  private readonly ids: IdGenerator;
  private readonly lookup: ResourceLookup | undefined;
  private readonly adapter: AdapterId;
  private readonly orchestration: OrchestrationService | undefined;
  private readonly runs: RunRepository | undefined;
  private readonly routing: WorkflowRouter | undefined;
  private readonly intake: readonly IntakeRule[];
  private readonly conclusion: WorkConclusion | undefined;
  private readonly conversations: ConversationService | undefined;

  // Adapter filtering, checkpointing, and typed event dispatch must stay together.
  async runOnce(limit = 100): Promise<number> {
    if (
      this.journal === undefined ||
      this.checkpoints === undefined ||
      this.work === undefined ||
      this.resources === undefined
    ) {
      throw new Error('InboundTranslator services are required to run evidence translation');
    }
    // Retry state is resource-scoped, so it progresses even when the provider
    // has no further observations for the broken resource.
    await this.resources.retryPendingWorkCorrelations();
    await this.applyDeferredExternalOutcomes();
    const checkpoint = `reactor:integration.${this.adapter}.inbound`;
    await this.retryPendingTranslations();
    const position = await this.checkpoints.load(checkpoint);
    const events = await this.journal.readAll(position, limit);
    for (const event of events) {
      await this.translateEvent(event);
      await this.checkpoints.save(checkpoint, event.globalPosition);
    }
    return events.length;
  }

  private async retryPendingTranslations(): Promise<void> {
    const events = await this.journal!.readStream(integrationStream(this.adapter));
    const owned = events
      .map(selectGitHubAdapterEvent)
      .filter((event): event is GitHubAdapterEvent => event !== null);
    const failures = new Set(
      owned
        .filter((event) => event.eventType === GitHubEventType.InboundTranslationFailed)
        .map((event) => event.payload.sourceEventId),
    );
    const pending = new Set(
      owned
        .filter((event) => event.eventType === GitHubEventType.InboundTranslationRetried)
        .map((event) => event.payload.sourceEventId),
    );
    const recovered = new Set(
      owned
        .filter((event) => event.eventType === GitHubEventType.InboundTranslationRecovered)
        .map((event) => event.payload.sourceEventId),
    );
    for (const event of owned) {
      if (
        pending.has(event.eventId) &&
        !failures.has(event.eventId) &&
        !recovered.has(event.eventId) &&
        this.isTranslatable(event)
      )
        await this.translateEvent(event);
    }
  }

  private isTranslatable(event: GitHubAdapterEvent): boolean {
    return (
      event.stream.id === this.adapter &&
      (event.eventType === GitHubEventType.WorkObserved ||
        event.eventType === GitHubEventType.CommentObserved)
    );
  }

  private async translateEvent(
    event: Parameters<typeof selectGitHubAdapterEvent>[0],
  ): Promise<void> {
    const owned = selectGitHubAdapterEvent(event);
    if (owned === null || !this.isTranslatable(owned)) return;
    if (await this.failureRecorded(owned.eventId)) return;
    try {
      if (owned.eventType === GitHubEventType.WorkObserved) await this.apply(owned);
      if (owned.eventType === GitHubEventType.CommentObserved) {
        await this.recordConversationEntry(owned);
        if (!(await this.suppressWorkItemEffects(owned)))
          await applyReviewSignal({
            event: owned,
            journal: this.journal!,
            resources: this.resources!,
            work: this.work!,
            lookup: this.lookup,
            pullRequests: this.pullRequests,
            ids: this.ids,
            adapter: this.adapter,
            orchestration: this.orchestration,
          });
        await applyWatchGateVerdictSignal({
          event: owned,
          runs: this.runs,
          orchestration: this.orchestration,
        });
      }
      if (await this.retryRecorded(owned.eventId)) await this.recordTranslationRecovery(owned);
    } catch (error) {
      await this.recordTranslationFailure(owned, error);
    }
  }

  private async recordConversationEntry(
    event: Extract<GitHubAdapterEvent, { readonly eventType: typeof GitHubEventType.CommentObserved }>,
  ): Promise<void> {
    if (this.conversations === undefined || this.resources === undefined) return;
    const resource = await this.resources.findByExternalKey({ adapter: this.adapter, key: event.payload.externalKey });
    if (resource === null) return;
    const correlation = await this.resources.primaryCorrelation(resource.resourceId);
    if (correlation === null) return;
    const conversationId = conversationIdForWorkItem(correlation.workItemId);
    await this.conversations.record({
      conversationId,
      entryId: event.eventId,
      body: event.payload.body,
      origin: { kind: 'external', adapter: this.adapter, actorId: event.payload.actor.id, resourceId: resource.resourceId, threadId: resource.externalKey.key, messageId: event.eventId },
    }, commandContext(event));
  }

  private async failureRecorded(sourceEventId: string): Promise<boolean> {
    return (await this.journal!.readStream(integrationStream(this.adapter))).some((event) => {
      const owned = selectGitHubAdapterEvent(event);
      return (
        owned?.eventType === GitHubEventType.InboundTranslationFailed &&
        owned.payload.sourceEventId === sourceEventId
      );
    });
  }

  private async retryRecorded(sourceEventId: string): Promise<boolean> {
    return (await this.journal!.readStream(integrationStream(this.adapter))).some((event) => {
      const owned = selectGitHubAdapterEvent(event);
      return (
        owned?.eventType === GitHubEventType.InboundTranslationRetried &&
        owned.payload.sourceEventId === sourceEventId
      );
    });
  }

  private async recordTranslationRecovery(event: GitHubAdapterEvent): Promise<void> {
    const stream = integrationStream(this.adapter);
    const eventId = `github:inbound-translation-recovered:${this.adapter}:${event.eventId}`;
    const existing = await this.journal!.readStream(stream);
    if (existing.some((candidate) => candidate.eventId === eventId)) return;
    await this.journal!.append(stream, existing.length, [
      createEventDraft({
        eventId,
        eventType: GitHubEventType.InboundTranslationRecovered,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        causationId: event.eventId,
        actor: { kind: EventActorKind.Integration, id: this.adapter },
        source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
        stream,
        payload: { adapter: this.adapter, sourceEventId: event.eventId },
      }),
    ]);
  }

  private async recordTranslationFailure(event: GitHubAdapterEvent, error: unknown): Promise<void> {
    const stream = integrationStream(this.adapter);
    const existing = await this.journal!.readStream(stream);
    const retries = existing.reduce((count, candidate) => {
      const owned = selectGitHubAdapterEvent(candidate);
      return (
        count +
        Number(
          owned?.eventType === GitHubEventType.InboundTranslationRetried &&
            owned.payload.sourceEventId === event.eventId,
        )
      );
    }, 0);
    const attempt = retries + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = retries >= 3;
    const eventId = terminal
      ? `github:inbound-translation-failed:${this.adapter}:${event.eventId}`
      : `github:inbound-translation-retried:${this.adapter}:${event.eventId}:${attempt}`;
    const payload = terminal
      ? {
          adapter: this.adapter,
          sourceEventId: event.eventId,
          attempt,
          message,
          globalPosition: event.globalPosition,
          eventType: event.eventType,
          correlationId: event.correlationId,
          causationId: event.causationId,
          failedAt: event.occurredAt,
        }
      : { adapter: this.adapter, sourceEventId: event.eventId, attempt, message };
    await this.appendTranslationDiagnostic(
      eventId,
      terminal
        ? GitHubEventType.InboundTranslationFailed
        : GitHubEventType.InboundTranslationRetried,
      event,
      payload,
    );
    console.error(`Inbound translation failed for ${event.eventId} (attempt ${attempt})`, error);
  }

  private async appendTranslationDiagnostic(
    eventId: string,
    eventType:
      | typeof GitHubEventType.InboundTranslationRetried
      | typeof GitHubEventType.InboundTranslationFailed,
    source: GitHubAdapterEvent,
    payload:
      | {
          readonly adapter: string;
          readonly sourceEventId: string;
          readonly attempt: number;
          readonly message: string;
        }
      | {
          readonly adapter: string;
          readonly sourceEventId: string;
          readonly attempt: number;
          readonly message: string;
          readonly globalPosition: number;
          readonly eventType: string;
          readonly correlationId: string;
          readonly causationId: string;
          readonly failedAt: string;
        },
  ): Promise<void> {
    const stream = integrationStream(this.adapter);
    for (let contentionAttempts = 0; contentionAttempts < 3; contentionAttempts += 1) {
      const existing = await this.journal!.readStream(stream);
      if (existing.some((event) => event.eventId === eventId)) return;
      try {
        await this.journal!.append(stream, existing.length, [
          createEventDraft({
            eventId,
            eventType,
            occurredAt: source.occurredAt,
            correlationId: source.correlationId,
            causationId: source.eventId,
            actor: { kind: EventActorKind.Integration, id: this.adapter },
            source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
            stream,
            payload,
          }),
        ]);
        return;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
    throw new Error(`Could not record inbound translation diagnostic ${eventId} after contention`);
  }

  private async suppressWorkItemEffects(
    event: Extract<GitHubAdapterEvent, { eventType: typeof GitHubEventType.CommentObserved }>,
  ): Promise<boolean> {
    const resourceIdValue = await this.lookup?.resourceIdForExternalKey({
      adapter: this.adapter,
      key: event.payload.externalKey,
    });
    if (resourceIdValue === null || resourceIdValue === undefined) return false;
    const hasPrimary = (await this.resources!.correlations(resourceIdValue)).some(
      (correlation) => correlation.role === ResourceCorrelationRole.Primary,
    );
    if (hasPrimary) return false;
    await this.resources!.noteMissingPrimaryCorrelation(
      resourceIdValue,
      'Resource has no active primary WorkItem correlation',
      commandContext(event),
    );
    return true;
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
    if (intake.ignored) return;
    const identity = await this.resolveIdentity(
      event.eventId,
      { adapter: this.adapter, key: payload.externalKey },
      intake.admitted,
    );
    if (identity === null) return;
    if (!identity.created) {
      await this.applyExistingObservation(event, payload, context, pullRequests, identity);
      return;
    }
    const resourceIdValue = identity.resourceId;
    const workItemIdValue = identity.workItemId;
    if (workItemIdValue === null) throw new Error('Created identity is missing a WorkItem');
    await this.recordAdmissionStarted(event, identity);
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
              BuiltInResourceCapability.ChangedFiles,
            ]
          : [BuiltInResourceCapability.Commentable, BuiltInResourceCapability.Completable],
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

  private async applyExistingObservation(
    event: Extract<GitHubAdapterEvent, { eventType: typeof GitHubEventType.WorkObserved }>,
    payload: ExternalWorkObservedPayload,
    context: ReturnType<typeof commandContext>,
    pullRequests: PullRequestService,
    identity: ResolvedIdentity,
  ): Promise<void> {
    if (identity.missingPrimary) {
      await this.recordMissingPrimaryObservation(identity.resourceId, payload, context);
      return;
    }
    const workItemIdValue = identity.workItemId;
    if (workItemIdValue === null) throw new Error('Resolved identity is missing a WorkItem');
    if (identity.deleted) {
      await this.recordDeletedWorkObservation(event, workItemIdValue);
      return;
    }
    await this.applyReobservation({
      payload,
      context,
      pullRequests,
      resourceId: identity.resourceId,
      workItemId: workItemIdValue,
    });
  }

  private async recordMissingPrimaryObservation(
    resourceIdValue: ResourceId,
    payload: ExternalWorkObservedPayload,
    context: ReturnType<typeof commandContext>,
  ): Promise<void> {
    const current = await this.resources!.get(resourceIdValue);
    if (current === null) throw new Error(`Resource ${resourceIdValue} could not be loaded`);
    if (current.revision !== payload.revision)
      await this.resources!.discover(
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
    await this.resources!.noteMissingPrimaryCorrelation(
      resourceIdValue,
      'Resource has no active primary WorkItem correlation',
      context,
    );
    await this.resources!.observeExternalOutcome(
      resourceIdValue,
      {
        sourceObservationId: context.commandId,
        ...(payload.outcome === undefined ? {} : { outcome: payload.outcome }),
        revision: payload.revision,
      },
      context,
    );
  }

  private async applyDeferredExternalOutcomes(): Promise<void> {
    if (this.conclusion === undefined) return;
    for (const pending of await this.resources!.pendingExternalOutcomes()) {
      const primary = (await this.resources!.correlations(pending.resourceId)).find(
        (correlation) => correlation.role === ResourceCorrelationRole.Primary,
      );
      if (primary === undefined) continue;
      await concludeObservedWork(
        { work: this.work!, conclusion: this.conclusion },
        {
          workItemId: primary.workItemId,
          outcome: pending.outcome,
          reason: `${this.adapter} external outcome observed while correlation was unresolved`,
        },
      );
      await this.resources!.consumeExternalOutcome(
        pending.resourceId,
        pending.sourceObservationId,
        {
          commandId: `github:consume-external-outcome:${pending.sourceObservationId}`,
          correlationId: correlationId(`github:external-outcome:${pending.sourceObservationId}`),
          occurredAt: new Date().toISOString(),
          actor: { kind: EventActorKind.Integration, id: this.adapter },
        },
      );
    }
  }

  private async applyReobservation(input: {
    readonly payload: ExternalWorkObservedPayload;
    readonly context: ReturnType<typeof commandContext>;
    readonly pullRequests: PullRequestService;
    readonly resourceId: ResourceId;
    readonly workItemId: WorkItemId;
  }): Promise<void> {
    const {
      payload,
      context,
      pullRequests,
      resourceId: resourceIdValue,
      workItemId: workItemIdValue,
    } = input;
    const current = await this.resources!.get(resourceIdValue);
    if (current === null) throw new Error(`Resource ${resourceIdValue} could not be loaded`);
    if (current.revision !== payload.revision) {
      await this.resources!.discover(
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
      const wakeCompletion = await this.unconsumedWakeCompletion(resourceIdValue);
      if (payload.outcome === undefined && wakeCompletion !== null) {
        await this.supersedeWakeCompletion(resourceIdValue, wakeCompletion, context);
      } else if (payload.outcome !== undefined && wakeCompletion !== null) {
        await this.consumeWakeCompletion(resourceIdValue, wakeCompletion, context);
      } else if (payload.outcome !== undefined && this.conclusion !== undefined) {
        await concludeObservedWork(
          { work: this.work!, conclusion: this.conclusion },
          {
            workItemId: workItemIdValue,
            outcome: payload.outcome,
            reason: `${this.adapter} ${payload.externalKey} closed`,
          },
        );
      }
    }
    if (payload.kind === 'pull-request')
      await pullRequests.observe(
        observePullRequest(current.resourceId, workItemIdValue, payload),
        context,
      );
  }

  /** A confirmed completion consumes exactly one matching terminal observation. */
  private async unconsumedWakeCompletion(resourceIdValue: ResourceId): Promise<string | null> {
    const events = await this.journal!.readStream(resourceStream(resourceIdValue));
    const intents = events.filter(
      (event) => event.eventType === ActivityEventType.IssueCompleteRequested,
    );
    for (const intent of intents) {
      if (
        events.some(
          (event) =>
            (event.eventType === ResourceEventType.IssueCompletionObservationConsumed ||
              event.eventType === ResourceEventType.IssueCompletionObservationSuperseded) &&
            event.payload !== null &&
            typeof event.payload === 'object' &&
            'intentEventId' in event.payload &&
            event.payload.intentEventId === intent.eventId,
        )
      )
        continue;
      const deliveries = await this.journal!.readStream(deliveryStream(intent.eventId));
      if (
        deliveries.some((event) => {
          const delivery = selectDeliveryEvent(event);
          return delivery?.eventType === DeliveryEventType.Confirmed;
        })
      )
        return intent.eventId;
    }
    return null;
  }

  private async consumeWakeCompletion(
    resourceIdValue: ResourceId,
    intentEventId: string,
    context: ReturnType<typeof commandContext>,
  ): Promise<void> {
    await this.resources!.consumeIssueCompletion(resourceIdValue, intentEventId, context);
  }

  private async supersedeWakeCompletion(
    resourceIdValue: ResourceId,
    intentEventId: string,
    context: ReturnType<typeof commandContext>,
  ): Promise<void> {
    await this.resources!.supersedeIssueCompletion(resourceIdValue, intentEventId, context);
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
      ...(this.conversations === undefined ? {} : { conversations: this.conversations }),
      resources: this.resources,
      orchestration: this.orchestration,
      routing: this.routing,
    };
  }

  private async resolveIdentity(
    sourceEventId: string,
    externalKey: { readonly adapter: string; readonly key: string },
    admitted: boolean,
  ): Promise<ResolvedIdentity | null> {
    const key = `${externalKey.adapter}:${externalKey.key}`;
    const recorded = await this.recordedAdmissionIdentity(sourceEventId);
    if (recorded !== undefined) {
      this.minted.set(key, recorded);
      return this.resumeAdmissionIdentity(recorded);
    }
    const inBatch = this.minted.get(key);
    if (inBatch !== undefined) return this.inBatchIdentity(inBatch);
    if (this.lookup === undefined) throw new Error('InboundTranslator lookup is required');
    const resourceIdValue = await this.lookup.resourceIdForExternalKey(externalKey);
    if (resourceIdValue !== null) return this.correlatedIdentity(key, resourceIdValue);
    // An ineligible object Wake has never seen produces no WorkItem, Run, or effect.
    if (!admitted) return null;
    return { ...this.mintIdentity(externalKey), created: true, deleted: false };
  }

  private async recordedAdmissionIdentity(sourceEventId: string) {
    const event = (await this.journal!.readStream(integrationStream(this.adapter)))
      .map(selectGitHubAdapterEvent)
      .find(
        (candidate) =>
          candidate?.eventType === GitHubEventType.AdmissionStarted &&
          candidate.payload.sourceEventId === sourceEventId,
      );
    if (event?.eventType !== GitHubEventType.AdmissionStarted) return undefined;
    return { resourceId: event.payload.resourceId, workItemId: event.payload.workItemId };
  }

  private async resumeAdmissionIdentity(identity: {
    readonly resourceId: ResourceId;
    readonly workItemId: WorkItemId;
  }): Promise<ResolvedIdentity> {
    const work = await this.work!.get(identity.workItemId);
    if (work?.deleted) return { ...identity, created: false, deleted: true };
    const correlation = (await this.resources!.correlations(identity.resourceId)).find(
      (candidate) =>
        candidate.role === ResourceCorrelationRole.Primary &&
        candidate.workItemId === identity.workItemId,
    );
    return { ...identity, created: correlation === undefined || work === null, deleted: false };
  }

  private async recordAdmissionStarted(
    source: Extract<GitHubAdapterEvent, { eventType: typeof GitHubEventType.WorkObserved }>,
    identity: ResolvedIdentity,
  ): Promise<void> {
    if (identity.workItemId === null) throw new Error('Created identity is missing a WorkItem');
    const stream = integrationStream(this.adapter);
    const eventId = `github:admission-started:${this.adapter}:${source.eventId}`;
    const existing = await this.journal!.readStream(stream);
    if (existing.some((event) => event.eventId === eventId)) return;
    await this.journal!.append(stream, existing.length, [
      createEventDraft({
        eventId,
        eventType: GitHubEventType.AdmissionStarted,
        occurredAt: source.occurredAt,
        correlationId: source.correlationId,
        causationId: source.eventId,
        actor: { kind: EventActorKind.Integration, id: this.adapter },
        source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
        stream,
        payload: {
          sourceEventId: source.eventId,
          resourceId: identity.resourceId,
          workItemId: identity.workItemId,
        },
      }),
    ]);
  }

  private async inBatchIdentity(identity: {
    readonly resourceId: ResourceId;
    readonly workItemId: WorkItemId;
  }): Promise<ResolvedIdentity> {
    const existing = await this.work?.get(identity.workItemId);
    return { ...identity, created: false, deleted: existing?.deleted === true };
  }

  private async correlatedIdentity(
    key: string,
    resourceIdValue: ResourceId,
  ): Promise<ResolvedIdentity> {
    if (this.resources === undefined) throw new Error('InboundTranslator resources are required');
    const correlation = (await this.resources.correlations(resourceIdValue)).find(
      (value) => value.role === ResourceCorrelationRole.Primary,
    );
    if (correlation === undefined) return this.historicalIdentity(resourceIdValue);
    const identity = { resourceId: resourceIdValue, workItemId: correlation.workItemId };
    this.minted.set(key, identity);
    return { ...identity, created: false, deleted: false };
  }

  private async historicalIdentity(resourceIdValue: ResourceId): Promise<ResolvedIdentity> {
    const historical = await this.resources!.primaryCorrelation(resourceIdValue);
    if (historical === null)
      return {
        resourceId: resourceIdValue,
        workItemId: null,
        created: false,
        deleted: false,
        missingPrimary: true,
      };
    const historicalWork = await this.work?.get(historical.workItemId);
    if (historicalWork?.deleted)
      return {
        resourceId: resourceIdValue,
        workItemId: historical.workItemId,
        created: false,
        deleted: true,
      };
    return {
      resourceId: resourceIdValue,
      workItemId: historical.workItemId,
      created: false,
      deleted: false,
      missingPrimary: true,
    };
  }

  private async recordDeletedWorkObservation(
    event: Extract<GitHubAdapterEvent, { eventType: typeof GitHubEventType.WorkObserved }>,
    workItemId: WorkItemId,
  ): Promise<void> {
    const stream = integrationStream(this.adapter);
    const eventId = `github:deleted-work-skip:${event.eventId}:${workItemId}`;
    const payload = {
      externalKey: event.payload.externalKey,
      workItemId,
      sourceEventId: event.eventId,
      revision: event.payload.revision,
      reason: 'work-item-deleted' as const,
    };
    for (;;) {
      const existing = await this.journal!.readStream(stream);
      const recorded = existing.find((candidate) => candidate.eventId === eventId);
      if (recorded !== undefined) {
        const diagnostic = selectGitHubAdapterEvent(recorded);
        if (
          diagnostic?.eventType !== GitHubEventType.DeletedWorkObservationSkipped ||
          JSON.stringify(diagnostic.payload) !== JSON.stringify(payload)
        )
          throw new Error(`Event id ${eventId} has already been used with different content`);
        return;
      }
      try {
        await this.journal!.append(stream, existing.length, [
          createEventDraft({
            eventId,
            eventType: GitHubEventType.DeletedWorkObservationSkipped,
            occurredAt: event.occurredAt,
            correlationId: event.correlationId,
            causationId: event.eventId,
            actor: { kind: EventActorKind.Integration, id: this.adapter },
            source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
            stream,
            payload,
          }),
        ]);
        return;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }
}
