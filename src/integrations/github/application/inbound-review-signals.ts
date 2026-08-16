import {
  ActivityOutcomeKind,
  ReviewActorKind,
  ReviewDecisionKind,
  ReviewerAuthorizationSource,
  createPullRequestService,
  isReviewAuthorized,
  type PullRequestService,
} from '../../../activities/index.js';
import type { EventJournal, IdGenerator } from '../../../kernel/index.js';
import { ApprovalAuthorityKind, type OrchestrationService } from '../../../orchestration/index.js';
import type { ResourceLookup, ResourceService } from '../../../resources/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationRole,
  ResourceStreamKind,
  resourceId,
} from '../../../resources/index.js';
import { WorkStatus, type WorkService } from '../../../work/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { GitHubAdapterEvent, GitHubEventType } from '../contracts/events.js';
import { UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { commandContext } from './inbound-context.js';
import { ignoreIneligibleOperatorRetry } from './operator-retry-command.js';
import { translateGitHubReviewCommand } from './review-command-translator.js';

type CommentObservedEvent = Extract<
  GitHubAdapterEvent,
  { eventType: typeof GitHubEventType.CommentObserved }
>;

export async function applyReviewSignal(input: {
  readonly event: CommentObservedEvent;
  readonly journal: EventJournal | undefined;
  readonly resources: ResourceService | undefined;
  readonly work: WorkService | undefined;
  readonly lookup: ResourceLookup | undefined;
  readonly pullRequests: PullRequestService | undefined;
  readonly ids: IdGenerator;
  readonly adapter: AdapterId;
  readonly orchestration: OrchestrationService | undefined;
}): Promise<void> {
  const { event, journal, resources, work, lookup, adapter, orchestration } = input;
  if (journal === undefined || resources === undefined || work === undefined) return;
  const payload = event.payload;
  if (payload.reviewKind === 'issue') {
    await applyIssueReviewSignal({ event, resources, work, lookup, orchestration, adapter });
    return;
  }
  await applyFormalReviewSignal({ ...input, journal, resources, work });
}

async function applyFormalReviewSignal(input: {
  readonly event: CommentObservedEvent;
  readonly journal: EventJournal;
  readonly resources: ResourceService;
  readonly work: WorkService;
  readonly lookup: ResourceLookup | undefined;
  readonly pullRequests: PullRequestService | undefined;
  readonly ids: IdGenerator;
  readonly adapter: AdapterId;
  readonly orchestration: OrchestrationService | undefined;
}): Promise<void> {
  const { event, journal, resources, work, lookup, pullRequests, ids, adapter, orchestration } =
    input;
  const payload = event.payload;
  if (payload.reviewKind !== 'formal') return;
  if (lookup === undefined) throw new Error('InboundTranslator lookup is required');
  let resourceIdValue = await lookup.resourceIdForExternalKey({
    adapter,
    key: payload.externalKey,
  });
  if (resourceIdValue === null) resourceIdValue = resourceId(ids.next(ResourceStreamKind.Resource));
  const proposed = translateGitHubReviewCommand({
    resourceId: resourceIdValue,
    revision: payload.revision,
    actorId: payload.actor.id,
    actorKind: payload.actor.kind,
    resourceAuthorId: payload.resourceAuthorId ?? UnknownGitHubIdentity,
    authorization: payload.authorization ?? { source: ReviewerAuthorizationSource.None },
    providerEventId: event.eventId,
    body: payload.body,
  });
  if (proposed === null) return;
  const context = commandContext(event);
  const pullRequestService = pullRequests ?? createPullRequestService(journal, work, resources);
  if (proposed.kind === ReviewDecisionKind.Accepted)
    await pullRequestService.acceptReviewSignal(
      { ...proposed, origin: 'provider-native-review', acceptedEventId: proposed.providerEventId },
      context,
    );
  else
    await pullRequestService.requestChangesSignal(
      { ...proposed, requestedEventId: proposed.providerEventId },
      context,
    );
  await applyPullRequestWorkflowSignal({
    event,
    resources,
    lookup,
    orchestration,
    adapter,
    outcome:
      proposed.kind === ReviewDecisionKind.Accepted
        ? ActivityOutcomeKind.Done
        : ActivityOutcomeKind.Rejected,
  });
}

async function applyIssueReviewSignal(input: {
  readonly event: CommentObservedEvent;
  readonly resources: ResourceService | undefined;
  readonly work: WorkService | undefined;
  readonly lookup: ResourceLookup | undefined;
  readonly orchestration: OrchestrationService | undefined;
  readonly adapter: AdapterId;
}): Promise<void> {
  const { event, resources, work, lookup, orchestration, adapter } = input;
  if (event.payload.actor.kind !== ReviewActorKind.Human || isWakeDelivery(event.payload.body))
    return;
  if (resources === undefined || lookup === undefined || orchestration === undefined) return;
  const resourceIdValue = await lookup.resourceIdForExternalKey({
    adapter,
    key: event.payload.externalKey,
  });
  if (resourceIdValue === null) return;
  const resource = await resources.get(resourceIdValue);
  const command = recognizedCommand(event.payload.body);
  if (command === '/retry') {
    await applyIssueRetrySignal({
      event,
      resources,
      work,
      orchestration,
      resourceId: resourceIdValue,
    });
    return;
  }
  if (resource?.kind === BuiltInResourceKind.PullRequest) {
    await applyWorkflowSignal({
      event,
      resources,
      orchestration,
      resourceId: resourceIdValue,
      outcome: command === '/approved' ? ActivityOutcomeKind.Done : ActivityOutcomeKind.Rejected,
    });
    return;
  }
  if (command !== null) await applyIssueApprovalSignal({ ...input, command });
}

async function applyIssueRetrySignal(input: {
  readonly event: CommentObservedEvent;
  readonly resources: ResourceService;
  readonly work: WorkService | undefined;
  readonly orchestration: OrchestrationService | undefined;
  readonly resourceId: ReturnType<typeof resourceId>;
}): Promise<void> {
  const { event, resources, work, orchestration, resourceId: resourceIdValue } = input;
  if (work === undefined || orchestration === undefined) return;
  if (
    !isReviewAuthorized({
      actorId: event.payload.actor.id,
      actorKind: event.payload.actor.kind,
      resourceAuthorId: UnknownGitHubIdentity,
      authorization: event.payload.authorization ?? { source: ReviewerAuthorizationSource.None },
    })
  )
    return;
  const workItemIds = (await resources.correlations(resourceIdValue))
    .filter((correlation) => correlation.role === ResourceCorrelationRole.Primary)
    .map((correlation) => correlation.workItemId);
  for (const workflow of await orchestration.listAll()) {
    if (
      !workItemIds.includes(workflow.workItemId) ||
      workflow.parentWorkflowInstanceId !== undefined
    )
      continue;
    const item = await work.get(workflow.workItemId);
    if (item === null || item.deleted || item.frozen || item.state !== WorkStatus.Open) continue;
    await ignoreIneligibleOperatorRetry(() =>
      orchestration.retryBlockedFailedStage(workflow.workflowInstanceId, commandContext(event)),
    );
  }
}

async function applyIssueApprovalSignal(input: {
  readonly event: CommentObservedEvent;
  readonly command: '/approved' | '/changes';
  readonly resources: ResourceService | undefined;
  readonly lookup: ResourceLookup | undefined;
  readonly orchestration: OrchestrationService | undefined;
  readonly adapter: AdapterId;
}): Promise<void> {
  const { event, command, resources, lookup, orchestration, adapter } = input;
  if (resources === undefined || lookup === undefined || orchestration === undefined) return;
  const resourceIdValue = await lookup.resourceIdForExternalKey({
    adapter,
    key: event.payload.externalKey,
  });
  if (resourceIdValue === null) return;
  await applyWorkflowSignal({
    event,
    resources,
    orchestration,
    resourceId: resourceIdValue,
    outcome: command === '/approved' ? ActivityOutcomeKind.Done : ActivityOutcomeKind.Rejected,
    resumeBlockedOnChanges: command === '/changes',
  });
}

async function applyPullRequestWorkflowSignal(input: {
  readonly event: CommentObservedEvent;
  readonly resources: ResourceService | undefined;
  readonly lookup: ResourceLookup | undefined;
  readonly orchestration: OrchestrationService | undefined;
  readonly adapter: AdapterId;
  readonly outcome: typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected;
}): Promise<void> {
  const { event, lookup, resources, orchestration, adapter, outcome } = input;
  if (
    event.payload.actor.kind !== ReviewActorKind.Human ||
    lookup === undefined ||
    resources === undefined ||
    orchestration === undefined
  )
    return;
  const resourceIdValue = await lookup.resourceIdForExternalKey({
    adapter,
    key: event.payload.externalKey,
  });
  if (resourceIdValue === null) return;
  await applyWorkflowSignal({
    event,
    resources,
    orchestration,
    resourceId: resourceIdValue,
    outcome,
  });
}

async function applyWorkflowSignal(input: {
  readonly event: CommentObservedEvent;
  readonly resources: ResourceService;
  readonly orchestration: OrchestrationService;
  readonly resourceId: ReturnType<typeof resourceId>;
  readonly outcome: typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected;
  readonly resumeBlockedOnChanges?: boolean;
}): Promise<void> {
  const {
    event,
    resources,
    orchestration,
    resourceId: resourceIdValue,
    outcome,
    resumeBlockedOnChanges = false,
  } = input;
  const workItemIds = (await resources.correlations(resourceIdValue))
    .filter((correlation) => correlation.role === ResourceCorrelationRole.Primary)
    .map((correlation) => correlation.workItemId);
  for (const workflow of await orchestration.listAll()) {
    if (!workItemIds.includes(workflow.workItemId)) continue;
    if (workflow.waitingFor !== undefined) {
      await orchestration.acceptSignal(
        workflow.workflowInstanceId,
        {
          kind: workflow.waitingFor.signalKind,
          outcome,
          actorId: event.payload.actor.id,
          actorDecision: {
            authorized: event.payload.actor.kind === ReviewActorKind.Human,
            evidenceId: event.eventId,
          },
          providerEventId: event.eventId,
          ...(event.payload.actor.kind === ReviewActorKind.Human
            ? { authority: { kind: ApprovalAuthorityKind.Human } }
            : {}),
        },
        commandContext(event),
      );
    } else if (resumeBlockedOnChanges) {
      await orchestration.resumeBlockedStageForChanges(
        workflow.workflowInstanceId,
        commandContext(event),
      );
    }
  }
}

function isWakeDelivery(body: string): boolean {
  return body.includes('<!-- wake:');
}

function recognizedCommand(body: string): '/approved' | '/changes' | '/retry' | null {
  const normalized = body.trim().toLowerCase();
  if (normalized === '/approved') return '/approved';
  if (normalized === '/changes' || normalized.startsWith('/changes ')) return '/changes';
  if (normalized === '/retry') return '/retry';
  return null;
}
