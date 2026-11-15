import type { EventJournal } from '@atolis-hq/eventing';
import {
  isReviewAuthorized,
  isTrustedReviewer,
  ReviewerAuthorizationSource,
} from '../../../activities/index.js';
import {
  conversationApprovalSubject,
  isHumanConversationApprovalWait,
  type OrchestrationService,
  type WorkflowInstanceView,
} from '../../../orchestration/index.js';
import {
  BuiltInResourceKind,
  resourceId,
  resourceStream,
  type ResourceService,
  type ResourceView,
} from '../../../resources/index.js';
import type { WorkItemId } from '../../../work/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import { deliveryStream, integrationStream } from '../../contracts/streams.js';
import { DeliveryEventType, selectDeliveryEvent } from '../../delivery/contracts/events.js';
import {
  DeliveryIntentEventType,
  selectDeliveryIntentEvent,
} from '../../delivery/contracts/intents.js';
import { DeliveryResultKind } from '../../delivery/contracts/vocabulary.js';
import {
  GitHubEventType,
  selectGitHubAdapterEvent,
  type GitHubAdapterEventOf,
} from '../contracts/events.js';
import { GitHubBuiltInCommand, UnknownGitHubIdentity } from '../contracts/vocabulary.js';
import { formatAgentRunComment } from './agent-run-comment.js';
import { isHumanNonWakeReply, recognizedCommand } from './inbound-comment-syntax.js';

interface Authorization {
  readonly reviewAuthorized: boolean;
  readonly approvalRejectionReason?: string;
  readonly approvalSubjects?: readonly string[];
}

export async function conversationReviewAuthorization(input: {
  readonly event: GitHubAdapterEventOf<typeof GitHubEventType.CommentObserved>;
  readonly journal: EventJournal;
  readonly resources: ResourceService;
  readonly resource: ResourceView;
  readonly workItemId: WorkItemId;
  readonly adapter: AdapterId;
  readonly orchestration?: OrchestrationService | undefined;
  readonly authenticatedLogin?: (() => Promise<string>) | undefined;
}): Promise<Authorization> {
  const reviewAuthorized = trustedConversationReviewer(input.event);
  if (!isApproval(input.event.event.payload.body) || !reviewAuthorized) return { reviewAuthorized };
  const workflows = ((await input.orchestration?.listAll()) ?? []).filter(
    (workflow) =>
      workflow.workItemId === input.workItemId && isHumanConversationApprovalWait(workflow),
  );
  const approvalSubjects = workflows.map(conversationApprovalSubject);
  for (const workflow of workflows) {
    const approvalRejectionReason = await artifactRejection(input, workflow);
    if (approvalRejectionReason !== undefined)
      return { reviewAuthorized, approvalSubjects, approvalRejectionReason };
  }
  return { reviewAuthorized, approvalSubjects };
}

function isApproval(body: string): boolean {
  const command = recognizedCommand(body);
  return command === GitHubBuiltInCommand.Approved || command === GitHubBuiltInCommand.Accepted;
}

function trustedConversationReviewer(event: Input['event']): boolean {
  const { actor, authorization, resourceAuthorId, body } = event.event.payload;
  if (!isHumanNonWakeReply(actor.kind, body)) return false;
  const reviewer = {
    actorId: actor.id,
    actorKind: actor.kind,
    authorization: authorization ?? { source: ReviewerAuthorizationSource.None },
  };
  return isApproval(body)
    ? isTrustedReviewer(reviewer)
    : isReviewAuthorized({
        ...reviewer,
        resourceAuthorId: resourceAuthorId ?? UnknownGitHubIdentity,
      });
}

async function artifactRejection(
  input: Input,
  workflow: WorkflowInstanceView,
): Promise<string | undefined> {
  const target =
    workflow.waitingFor?.resourceId === undefined
      ? input.resource
      : await input.resources.get(resourceId(workflow.waitingFor.resourceId));
  if (target === null) return unknownAttribution;
  const pr = target.kind === BuiltInResourceKind.PullRequest;
  const author = pr ? await pullRequestAuthor(input, target) : await planProducer(input, workflow);
  if (author === undefined || author.toLowerCase() === UnknownGitHubIdentity)
    return unknownAttribution;
  if (input.event.event.payload.actor.id.toLowerCase() !== author.toLowerCase()) return undefined;
  return pr
    ? 'Self-approval denied: the approver is the PR author.'
    : 'Self-approval denied: the approver is the artifact producer.';
}

const unknownAttribution =
  'Approval attribution is unknown or ambiguous for the artifact under review.';

type Input = Parameters<typeof conversationReviewAuthorization>[0];

async function pullRequestAuthor(input: Input, target: ResourceView): Promise<string | undefined> {
  if (target.externalKey.adapter !== input.adapter) return undefined;
  if (target.resourceId === input.resource.resourceId)
    return input.event.event.payload.resourceAuthorId;
  const observations = (await input.journal.readStream(integrationStream(input.adapter))).map(
    selectGitHubAdapterEvent,
  );
  const latest = observations
    .reverse()
    .find(
      (event) =>
        event?.event.eventType === GitHubEventType.WorkObserved &&
        event.event.payload.externalKey === target.externalKey.key,
    );
  return latest?.event.eventType === GitHubEventType.WorkObserved &&
    latest.event.payload.kind === BuiltInResourceKind.PullRequest
    ? latest.event.payload.resourceAuthorId
    : undefined;
}

async function planProducer(
  input: Input,
  workflow: WorkflowInstanceView,
): Promise<string | undefined> {
  if (workflow.pendingActivation === undefined) return undefined;
  const producers = new Set<string>();
  for (const correlation of await input.resources.correlationsForWork(input.workItemId)) {
    const resource = await input.resources.get(correlation.resourceId);
    if (resource?.externalKey.adapter !== input.adapter) continue;
    const facts = await input.journal.readStream(resourceStream(resource.resourceId));
    for (const fact of facts) {
      const intent = selectDeliveryIntentEvent(fact);
      if (intent === null) continue;
      const accounts = await publicationProducers(input, workflow, intent);
      if (accounts === undefined) return undefined;
      for (const account of accounts) producers.add(account.toLowerCase());
    }
  }
  return producers.size === 1 ? [...producers][0] : undefined;
}

async function publicationProducers(
  input: Input,
  workflow: WorkflowInstanceView,
  intent: NonNullable<ReturnType<typeof selectDeliveryIntentEvent>>,
): Promise<readonly string[] | undefined> {
  if (
    intent.event.eventType !== DeliveryIntentEventType.AgentRunPublishRequested ||
    intent.event.payload.workflowInstanceId !== workflow.workflowInstanceId ||
    intent.event.payload.activationId !== workflow.pendingActivation?.activationId
  )
    return [];
  const producers: string[] = [];
  const facts = await input.journal.readStream(deliveryStream(intent.event.eventId));
  for (const fact of facts) {
    const confirmation = confirmedPublication(selectDeliveryEvent(fact));
    if (confirmation === null) continue;
    let producer = confirmation.producerId;
    // GitHub agent publications carry the Wake marker in their delivered representation.
    if (
      producer === undefined &&
      formatAgentRunComment({
        ...intent.event.payload.report,
        idempotencyKey: intent.event.eventId,
      }).includes('<!-- wake:agent -->')
    )
      producer = await legacyProducer(input.authenticatedLogin);
    if (producer === undefined || producer.trim() === '') return undefined;
    producers.push(producer);
  }
  return producers;
}

function confirmedPublication(
  fact: ReturnType<typeof selectDeliveryEvent>,
): { readonly producerId?: string | undefined } | null {
  if (fact?.event.eventType === DeliveryEventType.Confirmed) return fact.event.payload;
  if (
    fact?.event.eventType === DeliveryEventType.Reconciled &&
    fact.event.payload.result === DeliveryResultKind.Confirmed
  )
    return fact.event.payload;
  return null;
}

async function legacyProducer(
  authenticatedLogin: Input['authenticatedLogin'],
): Promise<string | undefined> {
  try {
    return await authenticatedLogin?.();
  } catch {
    return undefined;
  }
}
