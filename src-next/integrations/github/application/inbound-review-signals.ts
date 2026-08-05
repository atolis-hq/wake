import {
  ReviewActorKind,
  ReviewDecisionKind,
  ReviewerAuthorizationSource,
  createPullRequestService,
  type PullRequestService,
} from '../../../activities/index.js';
import type { EventJournal, IdGenerator } from '../../../kernel/index.js';
import { signalName, type OrchestrationService } from '../../../orchestration/index.js';
import type { ResourceLookup, ResourceService } from '../../../resources/index.js';
import {
  ResourceCorrelationRole,
  ResourceStreamKind,
  resourceId,
} from '../../../resources/index.js';
import type { WorkService } from '../../../work/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { GitHubAdapterEvent, GitHubEventType } from '../contracts/events.js';
import { UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { commandContext } from './inbound-context.js';
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
  const { event, journal, resources, work, lookup, pullRequests, ids, adapter, orchestration } =
    input;
  if (journal === undefined || resources === undefined || work === undefined) return;
  const payload = event.payload;
  if (payload.reviewKind === 'issue') {
    await applyIssueApprovalSignal({ event, resources, lookup, orchestration, adapter });
    return;
  }
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
}

async function applyIssueApprovalSignal(input: {
  readonly event: CommentObservedEvent;
  readonly resources: ResourceService | undefined;
  readonly lookup: ResourceLookup | undefined;
  readonly orchestration: OrchestrationService | undefined;
  readonly adapter: AdapterId;
}): Promise<void> {
  const { event, resources, lookup, orchestration, adapter } = input;
  if (resources === undefined || lookup === undefined || orchestration === undefined) return;
  const resourceIdValue = await lookup.resourceIdForExternalKey({
    adapter,
    key: event.payload.externalKey,
  });
  if (resourceIdValue === null) return;
  const workItemIds = (await resources.correlations(resourceIdValue))
    .filter((correlation) => correlation.role === ResourceCorrelationRole.Primary)
    .map((correlation) => correlation.workItemId);
  for (const workflow of await orchestration.listAll()) {
    if (!workItemIds.includes(workflow.workItemId)) continue;
    await orchestration.acceptSignal(
      workflow.workflowInstanceId,
      {
        kind: signalName('approved'),
        actorId: event.payload.actor.id,
        actorDecision: {
          authorized: event.payload.actor.kind === ReviewActorKind.Human,
          evidenceId: event.eventId,
        },
        providerEventId: event.eventId,
      },
      commandContext(event),
    );
  }
}
