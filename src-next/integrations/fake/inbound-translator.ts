import { z } from 'zod';
import {
  PullRequestCheckState,
  PullRequestState,
  ReviewActorKind,
  ReviewerAuthorizationSource,
} from '../../activities/index.js';
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
import type { ProviderServices } from '../contracts/provider.js';
import { FakeEventType, type FakeWorkEvidence } from './external-source.js';

const evidenceSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    tags: z.array(z.string().trim().min(1)).readonly().optional(),
    kind: z.enum(['issue', 'pull-request']).optional(),
    revision: z.string().min(1).optional(),
    baseRevision: z.string().min(1).optional(),
    checks: z.enum(['unknown', 'pending', 'passing', 'failing']).optional(),
    acceptedReview: z.boolean().optional(),
    changedFiles: z.array(z.string().min(1)).readonly().optional(),
    watchEvent: z.literal(FakeEventType.ReviewRequested).optional(),
    eligible: z.boolean().optional(),
  })
  .strict();

export class FakeInboundTranslator {
  constructor(
    private readonly adapter: AdapterId,
    private readonly services: ProviderServices,
  ) {}

  async runOnce(limit = 100): Promise<number> {
    const checkpoint = `reactor:integration.${this.adapter}.inbound`;
    const events = await this.services.journal.readAll(
      await this.services.checkpoints.load(checkpoint),
      limit,
    );
    for (const event of events) {
      if (event.eventType === FakeEventType.WorkObserved && event.stream.id === this.adapter)
        await this.apply(evidenceSchema.parse(event.payload), event);
      await this.services.checkpoints.save(checkpoint, event.globalPosition);
    }
    return events.length;
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
          : [BuiltInResourceCapability.Commentable],
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
    if (correlation === undefined)
      throw new Error(`Resource ${existing.resourceId} lacks a primary work correlation`);
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
          actorId: 'fake-reviewer',
          actorKind: ReviewActorKind.Human,
          acceptedEventId: `${event.eventId}:accepted-review`,
          resourceAuthorId: 'fake-author',
          authorization: {
            source: ReviewerAuthorizationSource.ConfiguredReviewer,
            reviewerId: 'fake-reviewer',
          },
        },
        context,
      );
  }
}
