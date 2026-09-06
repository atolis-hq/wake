/* eslint-disable max-lines */
import {
  correlationId,
  defineEventProcessor,
  EventActorKind,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  EventSourceKind,
  WrongExpectedSequenceError,
  type EventJournal,
  type EventProcessor,
} from '@atolis-hq/eventing';
import {
  ActivityEventType,
  createPullRequestService,
  isReviewAuthorized,
  ReviewerAuthorizationSource,
  selectActivityEvent,
  type ObservePullRequest,
  type PullRequestService,
} from '../../../activities/index.js';
import {
  conversationIdForWorkItem,
  ConversationOriginKind,
  type ConversationService,
} from '../../../conversations/index.js';
import type { RunRepository } from '../../../execution/index.js';
import { UlidIdGenerator, type IdGenerator } from '../../../kernel/index.js';
import type {
  ConversationSurfaceCapability,
  OrchestrationService,
} from '../../../orchestration/index.js';
import type { ResourceLookup, ResourceService } from '../../../resources/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  ResourceEventType,
  resourceId,
  resourceStream,
  selectResourceEvent,
  type ResourceId,
} from '../../../resources/index.js';
import type { WorkService } from '../../../work/index.js';
import { workItemId, type WorkItemId } from '../../../work/index.js';
import { admitObservedWork, type WorkAdmissionServices } from '../../application/work-admission.js';
import { concludeObservedWork } from '../../application/work-conclusion.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { evaluateIntakeRules, type IntakeRule } from '../../contracts/intake-rules.js';
import type { ProviderReconciler } from '../../contracts/intake.js';
import type { WorkConclusion, WorkflowRouter } from '../../contracts/provider.js';
import { deliveryStream, integrationStream } from '../../contracts/streams.js';
import { DeliveryEventType, selectDeliveryEvent } from '../../delivery/contracts/events.js';
import type { GitHubIntakeRuleConfig } from '../contracts/config.js';
import { createGitHubEventData } from '../contracts/event-factory.js';
import type {
  ExternalWorkObservedPayload,
  GitHubAdapterEvent,
  GitHubAdapterEventOf,
  GitHubEventPayloads,
} from '../contracts/events.js';
import { GitHubEventType, selectGitHubAdapterEvent } from '../contracts/events.js';
import { GitHubAdapter, UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { commandContext } from './inbound-context.js';
import { applyReviewSignal } from './inbound-review-signals.js';
import { applyWatchGateVerdictSignal } from './inbound-watch-gate-signals.js';
import { gitHubIntakeFacts, gitHubIntakeRules } from './intake-policy.js';
import { observePullRequest } from './pull-request-translation.js';

type TranslatableEvent =
  | GitHubAdapterEventOf<typeof GitHubEventType.WorkObserved>
  | GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>;

type TranslationDiagnosticEventType =
  | typeof GitHubEventType.InboundTranslationRetried
  | typeof GitHubEventType.InboundTranslationFailed;

type TranslationDiagnosticInput = {
  [Type in TranslationDiagnosticEventType]: {
    readonly eventType: Type;
    readonly payload: GitHubEventPayloads[Type];
  };
}[TranslationDiagnosticEventType];

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
  readonly conversationCapabilities?: readonly ConversationSurfaceCapability[];
}

export class InboundTranslator {
  private readonly minted = new Map<string, { resourceId: ResourceId; workItemId: WorkItemId }>();
  readonly processor: EventProcessor;
  readonly reconciler: ProviderReconciler;

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
    this.conversationCapabilities = dependencies.conversationCapabilities ?? [];
    this.processor = defineEventProcessor({
      consumer: `reactor:integration.${this.adapter}.inbound`,
      name: `integration.${this.adapter}.inbound`,
      owner: 'integrations',
      category: EventProcessorCategory.Translator,
      replayPolicy: EventProcessorReplayPolicy.Idempotent,
      select: (event) => this.selectInboundEvent(event),
      handle: async (event) => this.translateEvent(event),
    });
    this.reconciler = { reconcileOnce: () => this.reconcileOnce() };
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
  private readonly conversationCapabilities: readonly ConversationSurfaceCapability[];
  private conversationRecordRecoveryPending: boolean | undefined;

  private async reconcileOnce(): Promise<void> {
    if (this.journal === undefined || this.work === undefined || this.resources === undefined) {
      throw new Error('InboundTranslator services are required to run evidence translation');
    }
    await this.resources.retryPendingWorkCorrelations();
    await this.applyDeferredExternalOutcomes();
    await this.retryPendingConversationRecords();
  }

  private selectInboundEvent(
    event: Parameters<typeof selectGitHubAdapterEvent>[0],
  ): TranslatableEvent | null {
    const owned = selectGitHubAdapterEvent(event);
    return owned === null || !this.isTranslatable(owned) ? null : owned;
  }

  private isTranslatable(event: GitHubAdapterEvent): event is TranslatableEvent {
    return (
      event.stream.id === this.adapter &&
      (event.event.eventType === GitHubEventType.WorkObserved ||
        event.event.eventType === GitHubEventType.CommentObserved)
    );
  }

  private async translateEvent(owned: TranslatableEvent): Promise<void> {
    if (await this.failureRecorded(owned.event.eventId)) return;
    try {
      if (isGitHubAdapterEventType(owned, GitHubEventType.WorkObserved)) await this.apply(owned);
      if (isGitHubAdapterEventType(owned, GitHubEventType.CommentObserved)) {
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
            applyIssueCommands: false,
          });
        await applyWatchGateVerdictSignal({
          event: owned,
          runs: this.runs,
          orchestration: this.orchestration,
        });
        try {
          await this.recordConversationEntry(owned);
        } catch {
          await this.recordConversationDeferred(owned);
        }
      }
      if (await this.retryRecorded(owned.event.eventId))
        await this.recordTranslationRecovery(owned);
    } catch (error) {
      await this.recordTranslationFailure(owned, error);
      throw error;
    }
  }

  private async retryPendingConversationRecords(): Promise<void> {
    if (this.conversationRecordRecoveryPending === false) return;
    const stream = integrationStream(this.adapter);
    const events = (await this.journal!.readStream(stream))
      .map(selectGitHubAdapterEvent)
      .filter((event): event is GitHubAdapterEvent => event !== null);
    const recovered = new Set(
      events
        .filter((event) =>
          isGitHubAdapterEventType(event, GitHubEventType.ConversationRecordRecovered),
        )
        .map((event) => event.event.payload.sourceEventId),
    );
    const pending = events
      .filter(
        (event): event is GitHubAdapterEventOf<typeof GitHubEventType.ConversationRecordDeferred> =>
          isGitHubAdapterEventType(event, GitHubEventType.ConversationRecordDeferred),
      )
      .filter((event) => !recovered.has(event.event.payload.sourceEventId));
    this.conversationRecordRecoveryPending = pending.length > 0;
    let stillPending = false;
    for (const deferred of pending) {
      const source = events.find(
        (event) => event.event.eventId === deferred.event.payload.sourceEventId,
      );
      if (
        source === undefined ||
        !isGitHubAdapterEventType(source, GitHubEventType.CommentObserved)
      ) {
        stillPending = true;
        continue;
      }
      try {
        await this.recordConversationEntry(source);
      } catch {
        stillPending = true;
        continue;
      }
      await this.appendConversationRecordFact(GitHubEventType.ConversationRecordRecovered, source);
    }
    this.conversationRecordRecoveryPending = stillPending;
  }

  private async recordConversationDeferred(
    event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
  ): Promise<void> {
    await this.appendConversationRecordFact(GitHubEventType.ConversationRecordDeferred, event);
    this.conversationRecordRecoveryPending = true;
  }

  private async appendConversationRecordFact(
    eventType:
      | typeof GitHubEventType.ConversationRecordDeferred
      | typeof GitHubEventType.ConversationRecordRecovered,
    source: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
  ): Promise<void> {
    const stream = integrationStream(this.adapter);
    const eventId = `github:${eventType}:${this.adapter}:${source.event.eventId}`;
    const existing = await this.journal!.readStream(stream);
    if (existing.some((event) => event.event.eventId === eventId)) return;
    await this.journal!.appendToStream(stream, existing.length, [
      createGitHubEventData({
        eventId,
        eventType,
        occurredAt: source.event.occurredAt,
        correlationId: source.event.correlationId,
        causationId: source.event.eventId,
        actor: { kind: EventActorKind.Integration, id: this.adapter },
        source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
        payload: { adapter: this.adapter, sourceEventId: source.event.eventId },
      }),
    ]);
  }

  // Conversation reconciliation keeps all entry identity decisions in one ordered command path.
  private async recordConversationEntry(
    event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
  ): Promise<void> {
    if (this.conversations === undefined || this.resources === undefined) return;
    const resource = await this.resources.findByExternalKey({
      adapter: this.adapter,
      key: event.event.payload.externalKey,
    });
    if (resource === null) return;
    const correlation = await this.resources.primaryCorrelation(resource.resourceId);
    if (correlation === null) return;
    const conversationId = conversationIdForWorkItem(correlation.workItemId);
    await this.conversations.createForWorkItem(correlation.workItemId, commandContext(event));
    await this.conversations.associateResource(
      {
        conversationId,
        resourceId: resource.resourceId,
        threadId: resource.externalKey.key,
      },
      commandContext(event),
    );
    const externalId = observedCommentExternalId(event);
    const existing = await this.conversations.forWorkItem(correlation.workItemId);
    const priorEntry = existing?.entries.find(
      (entry) =>
        entry.origin.kind === ConversationOriginKind.External &&
        entry.origin.resourceId === resource.resourceId &&
        entry.origin.messageId === externalId,
    );
    if (
      existing?.entries.some((entry) =>
        entry.representations.some(
          (representation) =>
            representation.resourceId === resource.resourceId &&
            representation.externalId === externalId,
        ),
      )
    )
      return this.applyConversationCommand(correlation.workItemId, event);
    if (priorEntry !== undefined) {
      if (priorEntry.body !== event.event.payload.body)
        await this.conversations.revise(
          {
            conversationId,
            entryId: priorEntry.entryId,
            body: event.event.payload.body,
          },
          commandContext(event),
        );
      return this.applyConversationCommand(correlation.workItemId, event);
    }
    await this.conversations.record(
      {
        conversationId,
        entryId: event.event.eventId,
        body: event.event.payload.body,
        origin: {
          kind: ConversationOriginKind.External,
          adapter: this.adapter,
          actorId: event.event.payload.actor.id,
          resourceId: resource.resourceId,
          threadId: resource.externalKey.key,
          messageId: externalId,
          ...(event.event.payload.reviewKind !== 'issue' ||
          event.event.payload.location === undefined
            ? {}
            : { location: event.event.payload.location }),
        },
      },
      commandContext(event),
    );
    await this.applyConversationCommand(correlation.workItemId, event);
  }

  private async applyConversationCommand(
    workItemId: WorkItemId,
    event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
  ): Promise<void> {
    // Native formal reviews already carry their own verified decision and workflow signal.
    if (event.event.payload.reviewKind !== 'issue') return;
    await this.orchestration?.applyConversationCommand(
      workItemId,
      {
        body: event.event.payload.body,
        actorId: event.event.payload.actor.id,
        capabilities: this.conversationCapabilities,
        authorized: isAuthorizedConversationActor(event),
      },
      commandContext(event),
    );
  }

  private async failureRecorded(sourceEventId: string): Promise<boolean> {
    return (await this.journal!.readStream(integrationStream(this.adapter))).some((event) => {
      const owned = selectGitHubAdapterEvent(event);
      return (
        owned?.event.eventType === GitHubEventType.InboundTranslationFailed &&
        owned.event.payload.sourceEventId === sourceEventId
      );
    });
  }

  private async retryRecorded(sourceEventId: string): Promise<boolean> {
    return (await this.journal!.readStream(integrationStream(this.adapter))).some((event) => {
      const owned = selectGitHubAdapterEvent(event);
      return (
        owned?.event.eventType === GitHubEventType.InboundTranslationRetried &&
        owned.event.payload.sourceEventId === sourceEventId
      );
    });
  }

  private async recordTranslationRecovery(event: GitHubAdapterEvent): Promise<void> {
    const stream = integrationStream(this.adapter);
    const eventId = `github:inbound-translation-recovered:${this.adapter}:${event.event.eventId}`;
    const existing = await this.journal!.readStream(stream);
    if (existing.some((candidate) => candidate.event.eventId === eventId)) return;
    await this.journal!.appendToStream(stream, existing.length, [
      createGitHubEventData({
        eventId,
        eventType: GitHubEventType.InboundTranslationRecovered,
        occurredAt: event.event.occurredAt,
        correlationId: event.event.correlationId,
        causationId: event.event.eventId,
        actor: { kind: EventActorKind.Integration, id: this.adapter },
        source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
        payload: { adapter: this.adapter, sourceEventId: event.event.eventId },
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
          owned?.event.eventType === GitHubEventType.InboundTranslationRetried &&
            owned.event.payload.sourceEventId === event.event.eventId,
        )
      );
    }, 0);
    const attempt = retries + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = retries >= 3;
    const eventId = terminal
      ? `github:inbound-translation-failed:${this.adapter}:${event.event.eventId}`
      : `github:inbound-translation-retried:${this.adapter}:${event.event.eventId}:${attempt}`;
    const diagnostic: TranslationDiagnosticInput = terminal
      ? {
          eventType: GitHubEventType.InboundTranslationFailed,
          payload: {
            adapter: this.adapter,
            sourceEventId: event.event.eventId,
            attempt,
            message,
            globalPosition: event.globalPosition,
            eventType: event.event.eventType,
            correlationId: event.event.correlationId,
            causationId: event.event.causationId,
            failedAt: event.event.occurredAt,
          },
        }
      : {
          eventType: GitHubEventType.InboundTranslationRetried,
          payload: { adapter: this.adapter, sourceEventId: event.event.eventId, attempt, message },
        };
    await this.appendTranslationDiagnostic(eventId, event, diagnostic);
    console.error(
      `Inbound translation failed for ${event.event.eventId} (attempt ${attempt})`,
      error,
    );
  }

  private async appendTranslationDiagnostic(
    eventId: string,
    source: GitHubAdapterEvent,
    diagnostic: TranslationDiagnosticInput,
  ): Promise<void> {
    const stream = integrationStream(this.adapter);
    for (let contentionAttempts = 0; contentionAttempts < 3; contentionAttempts += 1) {
      const existing = await this.journal!.readStream(stream);
      if (existing.some((event) => event.event.eventId === eventId)) return;
      try {
        await this.journal!.appendToStream(stream, existing.length, [
          createGitHubEventData({
            eventId,
            occurredAt: source.event.occurredAt,
            correlationId: source.event.correlationId,
            causationId: source.event.eventId,
            actor: { kind: EventActorKind.Integration, id: this.adapter },
            source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
            ...diagnostic,
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
    event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
  ): Promise<boolean> {
    const resourceIdValue = await this.lookup?.resourceIdForExternalKey({
      adapter: this.adapter,
      key: event.event.payload.externalKey,
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
    event: GitHubAdapterEventOf<typeof GitHubEventType.WorkObserved>,
  ): Promise<void> {
    if (this.work === undefined || this.resources === undefined) return;
    const payload = event.event.payload;
    const context = commandContext(event);
    const pullRequests =
      this.pullRequests ?? createPullRequestService(this.journal!, this.work, this.resources);
    const intake = evaluateIntakeRules(this.intake, gitHubIntakeFacts(payload));
    if (intake.ignored) return;
    const identity = await this.resolveIdentity(
      event.event.eventId,
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
    event: GitHubAdapterEventOf<typeof GitHubEventType.WorkObserved>,
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
    const intents = events
      .map(selectActivityEvent)
      .filter((event) => event?.event.eventType === ActivityEventType.IssueCompleteRequested);
    for (const intent of intents) {
      if (intent?.event.eventType !== ActivityEventType.IssueCompleteRequested) continue;
      if (
        events.some((event) => {
          const resourceEvent = selectResourceEvent(event);
          return (
            (resourceEvent?.event.eventType ===
              ResourceEventType.IssueCompletionObservationConsumed ||
              resourceEvent?.event.eventType ===
                ResourceEventType.IssueCompletionObservationSuperseded) &&
            resourceEvent.event.payload.intentEventId === intent.event.eventId
          );
        })
      )
        continue;
      const deliveries = await this.journal!.readStream(deliveryStream(intent.event.eventId));
      if (
        deliveries.some((event) => {
          const delivery = selectDeliveryEvent(event);
          return delivery?.event.eventType === DeliveryEventType.Confirmed;
        })
      )
        return intent.event.eventId;
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
          candidate?.event.eventType === GitHubEventType.AdmissionStarted &&
          candidate.event.payload.sourceEventId === sourceEventId,
      );
    if (event?.event.eventType !== GitHubEventType.AdmissionStarted) return undefined;
    return {
      resourceId: event.event.payload.resourceId,
      workItemId: event.event.payload.workItemId,
    };
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
    source: GitHubAdapterEventOf<typeof GitHubEventType.WorkObserved>,
    identity: ResolvedIdentity,
  ): Promise<void> {
    if (identity.workItemId === null) throw new Error('Created identity is missing a WorkItem');
    const stream = integrationStream(this.adapter);
    const eventId = `github:admission-started:${this.adapter}:${source.event.eventId}`;
    const existing = await this.journal!.readStream(stream);
    if (existing.some((event) => event.event.eventId === eventId)) return;
    await this.journal!.appendToStream(stream, existing.length, [
      createGitHubEventData({
        eventId,
        eventType: GitHubEventType.AdmissionStarted,
        occurredAt: source.event.occurredAt,
        correlationId: source.event.correlationId,
        causationId: source.event.eventId,
        actor: { kind: EventActorKind.Integration, id: this.adapter },
        source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
        payload: {
          sourceEventId: source.event.eventId,
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
    event: GitHubAdapterEventOf<typeof GitHubEventType.WorkObserved>,
    workItemId: WorkItemId,
  ): Promise<void> {
    const stream = integrationStream(this.adapter);
    const eventId = `github:deleted-work-skip:${event.event.eventId}:${workItemId}`;
    const payload = {
      externalKey: event.event.payload.externalKey,
      workItemId,
      sourceEventId: event.event.eventId,
      revision: event.event.payload.revision,
      reason: 'work-item-deleted' as const,
    };
    for (;;) {
      const existing = await this.journal!.readStream(stream);
      const recorded = existing.find((candidate) => candidate.event.eventId === eventId);
      if (recorded !== undefined) {
        const diagnostic = selectGitHubAdapterEvent(recorded);
        if (
          diagnostic?.event.eventType !== GitHubEventType.DeletedWorkObservationSkipped ||
          JSON.stringify(diagnostic.event.payload) !== JSON.stringify(payload)
        )
          throw new Error(`Event id ${eventId} has already been used with different content`);
        return;
      }
      try {
        await this.journal!.appendToStream(stream, existing.length, [
          createGitHubEventData({
            eventId,
            eventType: GitHubEventType.DeletedWorkObservationSkipped,
            occurredAt: event.event.occurredAt,
            correlationId: event.event.correlationId,
            causationId: event.event.eventId,
            actor: { kind: EventActorKind.Integration, id: this.adapter },
            source: { kind: EventSourceKind.Internal, id: 'github-inbound-translator' },
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

function isAuthorizedConversationActor(
  event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
): boolean {
  const { actor, authorization } = event.event.payload;
  return isReviewAuthorized({
    actorId: actor.id,
    actorKind: actor.kind,
    resourceAuthorId: UnknownGitHubIdentity,
    authorization: authorization ?? { source: ReviewerAuthorizationSource.None },
  });
}

function observedCommentExternalId(
  event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>,
): string {
  const id = event.event.payload.raw.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : event.event.eventId;
}

function isGitHubAdapterEventType<Type extends GitHubAdapterEvent['event']['eventType']>(
  event: GitHubAdapterEvent,
  eventType: Type,
): event is GitHubAdapterEventOf<Type> {
  return event.event.eventType === eventType;
}
