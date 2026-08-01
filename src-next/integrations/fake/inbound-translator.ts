import { z } from 'zod';
import { correlationId, EventActorKind, type CommandContext } from '../../kernel/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
  resourceId,
  type ResourceId,
} from '../../resources/index.js';
import {
  PullRequestCheckState,
  PullRequestState,
  ReviewActorKind,
  ReviewerAuthorizationSource,
} from '../../activities/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../orchestration/index.js';
import type { ProviderServices } from '../contracts/provider.js';
import { FakeEventType, type FakeWorkEvidence } from './external-source.js';

const evidenceSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(['issue', 'pull-request']).optional(),
    revision: z.string().min(1).optional(),
    baseRevision: z.string().min(1).optional(),
    checks: z.enum(['unknown', 'pending', 'passing', 'failing']).optional(),
    acceptedReview: z.boolean().optional(),
    watchEvent: z.literal(FakeEventType.ReviewRequested).optional(),
    eligible: z.boolean().optional(),
  })
  .strict();

export class FakeInboundTranslator {
  constructor(
    private readonly adapter: string,
    private readonly services: ProviderServices,
  ) {}

  async runOnce(limit = 100): Promise<void> {
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
    await this.services.resources.discover(
      {
        resourceId: resource,
        kind: isPullRequest ? BuiltInResourceKind.PullRequest : BuiltInResourceKind.Issue,
        externalKey,
        capabilities: isPullRequest
          ? [
              BuiltInResourceCapability.Commentable,
              BuiltInResourceCapability.Reviewable,
              BuiltInResourceCapability.Approvable,
              BuiltInResourceCapability.Mergeable,
              BuiltInResourceCapability.Revisioned,
            ]
          : [BuiltInResourceCapability.Commentable],
        ...(evidence.revision === undefined ? {} : { revision: evidence.revision }),
      },
      context,
    );
    await this.services.work.create({ workItemId: work, objective: evidence.title }, context);
    await this.services.resources.correlate(
      resource,
      work,
      ResourceCorrelationRole.Primary,
      context,
    );
    if (isPullRequest) await this.observePullRequest(resource, work, evidence, event, context);
    const workflow = workflowInstanceId(`primary:${work}`);
    await this.services.orchestration.start(
      {
        workflowInstanceId: workflow,
        workItemId: work,
        workflowName: workflowName(this.services.defaultWorkflow),
        orchestrationGroupId: orchestrationGroupId(`primary:${work}`),
      },
      context,
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
