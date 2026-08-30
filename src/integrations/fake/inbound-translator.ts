import { z } from 'zod';
import {
  PullRequestCheckState,
  PullRequestState,
  ReviewActorKind,
  ReviewerAuthorizationSource,
} from '../../activities/index.js';
import {
  defineEventProcessor,
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventProcessor,
} from '../../eventing/index.js';
import type { EventEnvelope } from '../../kernel/index.js';
import { correlationId, EventActorKind, type CommandContext } from '../../kernel/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
  type ResourceId,
} from '../../resources/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import { admitObservedWork } from '../application/work-admission.js';
import type { AdapterId } from '../contracts/identifiers.js';
import type { ProviderReconciler } from '../contracts/intake.js';
import type { ProviderServices } from '../contracts/provider.js';
import { isIntegrationStream } from '../contracts/streams.js';
import { FakeEventType, type FakeWorkEvidence } from './external-source.js';

const evidenceSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    tags: z.array(z.string().trim().min(1)).readonly().optional(),
    kind: z.enum(['issue', 'pull-request']).optional(),
    revision: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    baseRevision: z.string().min(1).optional(),
    checks: z.enum(['unknown', 'pending', 'passing', 'failing']).optional(),
    acceptedReview: z.boolean().optional(),
    reviewActorId: z.string().min(1).optional(),
    reviewActorKind: z.enum(['human', 'bot']).optional(),
    reviewerId: z.string().min(1).optional(),
    changedFiles: z.array(z.string().min(1)).readonly().optional(),
    watchEvent: z.literal(FakeEventType.ReviewRequested).optional(),
    eligible: z.boolean().optional(),
  })
  .strict();

export class FakeInboundTranslator {
  readonly processor: EventProcessor;
  readonly reconciler: ProviderReconciler;

  constructor(
    private readonly adapter: AdapterId,
    private readonly services: ProviderServices,
  ) {
    this.processor = defineEventProcessor({
      consumer: `reactor:integration.${adapter}.inbound`,
      name: `integration.${adapter}.inbound`,
      owner: 'integrations',
      category: EventProcessorCategory.Translator,
      replayPolicy: EventProcessorReplayPolicy.Idempotent,
      select: (event) => this.selectEvidence(event),
      handle: async ({ evidence, event }) => this.apply(evidence, event),
    });
    this.reconciler = { reconcileOnce: () => this.reconcileOnce() };
  }

  private async reconcileOnce(): Promise<void> {
    await this.services.resources.retryPendingWorkCorrelations();
  }

  private selectEvidence(
    event: EventEnvelope,
  ): { readonly evidence: FakeWorkEvidence; readonly event: EventEnvelope } | null {
    if (
      event.eventType !== FakeEventType.WorkObserved ||
      !isIntegrationStream(event.stream) ||
      event.stream.id !== this.adapter
    )
      return null;
    return { evidence: evidenceSchema.parse(event.payload), event };
  }

  private async apply(
    evidence: FakeWorkEvidence,
    event: {
      readonly eventId: string;
      readonly correlationId: string;
      readonly occurredAt: string;
    },
  ): Promise<void> {
    if (evidence.eligible === false) return;
    const isPullRequest = evidence.kind === 'pull-request';
    const externalKey = { adapter: this.adapter, key: evidence.key };
    const context: CommandContext = {
      commandId: `${event.eventId}:inbound`,
      correlationId: correlationId(event.correlationId),
      occurredAt: event.occurredAt,
      actor: { kind: EventActorKind.Integration, id: this.adapter },
    };
    if (await this.updateExisting(externalKey, isPullRequest, evidence, event, context)) return;
    const resource = resourceId(this.services.ids.next('resource'));
    const work = workItemId(this.services.ids.next('work'));
    await admitObservedWork(
      this.services,
      {
        adapter: this.adapter,
        resourceId: resource,
        workItemId: work,
        kind: isPullRequest ? BuiltInResourceKind.PullRequest : BuiltInResourceKind.Issue,
        externalKey,
        capabilities: isPullRequest
          ? [
              BuiltInResourceCapability.Commentable,
              BuiltInResourceCapability.Reviewable,
              BuiltInResourceCapability.Approvable,
              BuiltInResourceCapability.Mergeable,
              BuiltInResourceCapability.Revisioned,
              ...(evidence.changedFiles === undefined
                ? []
                : [BuiltInResourceCapability.ChangedFiles]),
            ]
          : [BuiltInResourceCapability.Commentable, BuiltInResourceCapability.Completable],
        objective: evidence.title,
        tags: evidence.tags ?? [],
        ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
      },
      context,
      isPullRequest
        ? async () => {
            await this.observePullRequest(resource, work, evidence, event, context);
          }
        : undefined,
    );
  }

  private async updateExisting(
    externalKey: { readonly adapter: string; readonly key: string },
    isPullRequest: boolean,
    evidence: FakeWorkEvidence,
    event: { readonly eventId: string },
    context: CommandContext,
  ): Promise<boolean> {
    const existing = await this.services.resources.findByExternalKey(externalKey);
    if (existing === null) return false;
    const correlation = (await this.services.resources.correlations(existing.resourceId)).find(
      (candidate) => candidate.role === ResourceCorrelationRole.Primary,
    );
    if (correlation === undefined) {
      if (existing.revision !== evidence.revision)
        await this.services.resources.discover(
          {
            resourceId: existing.resourceId,
            kind: existing.kind,
            externalKey,
            capabilities: existing.capabilities,
            ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
          },
          context,
        );
      await this.services.resources.noteMissingPrimaryCorrelation(
        existing.resourceId,
        'Resource has no active primary WorkItem correlation',
        context,
      );
      return true;
    }
    if (existing.revision !== evidence.revision)
      await this.services.resources.discover(
        {
          resourceId: existing.resourceId,
          kind: existing.kind,
          externalKey,
          capabilities: existing.capabilities,
          ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
        },
        context,
      );
    if (isPullRequest)
      await this.observePullRequest(
        existing.resourceId,
        correlation.workItemId,
        evidence,
        event,
        context,
      );
    // Fake issue evidence has no terminal state, so its existing behaviour is
    // intentionally unchanged; production inbound suppression lives with the
    // provider observation that carries the terminal outcome.
    return true;
  }

  private async observePullRequest(
    resourceId: ResourceId,
    workItemId: WorkItemId,
    evidence: FakeWorkEvidence,
    event: { readonly eventId: string },
    context: CommandContext,
  ): Promise<void> {
    const revision = evidence.revision ?? 'unknown';
    await this.services.pullRequests.observe(
      {
        resourceId,
        workItemId,
        state: PullRequestState.Open,
        headRevision: revision,
        baseRevision: evidence.baseRevision ?? 'unknown',
        checks: evidence.checks ?? PullRequestCheckState.Unknown,
        ...(evidence.changedFiles === undefined ? {} : { changedFiles: evidence.changedFiles }),
      },
      context,
    );
    if (evidence.acceptedReview === true)
      await this.services.pullRequests.acceptReviewSignal(
        {
          resourceId,
          revision,
          actorId: evidence.reviewActorId ?? 'fake-reviewer',
          actorKind:
            evidence.reviewActorKind === 'bot' ? ReviewActorKind.Bot : ReviewActorKind.Human,
          acceptedEventId: `${event.eventId}:accepted-review`,
          resourceAuthorId: 'fake-author',
          authorization: {
            source: ReviewerAuthorizationSource.ConfiguredReviewer,
            reviewerId: evidence.reviewerId ?? evidence.reviewActorId ?? 'fake-reviewer',
          },
        },
        context,
      );
  }
}
