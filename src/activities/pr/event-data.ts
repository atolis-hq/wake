import { EventSourceKind, type CommandContext } from '../../kernel/index.js';
import {
  createActivityEventData,
  type ActivityEventDataInput,
} from '../contracts/event-factory.js';
import {
  ActivityEventType,
  type ActivityEventData,
  type ActivityEventPayloads,
  type PullRequestDenialPayload,
} from '../contracts/events.js';
import { activationId } from '../contracts/identifiers.js';
import { isReviewAuthorized } from '../review/authorization.js';
import type { AcceptReviewSignal, ObservePullRequest, RequestChangesSignal } from './contracts.js';

type ActivityEventDataOf<Type extends ActivityEventData['eventType']> = Extract<
  ActivityEventData,
  { eventType: Type }
>;

type DenialAudit = Omit<PullRequestDenialPayload, 'activationId' | 'idempotencyKey' | 'reason'>;

type DeliveryIntentType =
  typeof ActivityEventType.PrApproveRequested | typeof ActivityEventType.PrMergeRequested;

export const discovered = (
  { resourceId: _resourceId, ...command }: ObservePullRequest,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrDiscovered> =>
  fact({ ...metadata(ActivityEventType.PrDiscovered, context), payload: command });

export const revisionChanged = (
  command: ObservePullRequest,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrRevisionChanged> =>
  fact({
    ...metadata(ActivityEventType.PrRevisionChanged, context),
    payload: {
      headRevision: command.headRevision,
      baseRevision: command.baseRevision,
      ...(command.changedFiles === undefined ? {} : { changedFiles: command.changedFiles }),
    },
  });

export const stateChanged = (
  command: ObservePullRequest,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrStateChanged> =>
  fact({
    ...metadata(ActivityEventType.PrStateChanged, context),
    payload: { state: command.state },
  });

export const checksChanged = (
  command: ObservePullRequest,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrChecksChanged> =>
  fact({
    ...metadata(ActivityEventType.PrChecksChanged, context),
    payload: { checks: command.checks },
  });

export const reviewAccepted = (
  command: AcceptReviewSignal,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrReviewAccepted> =>
  fact({
    ...metadata(ActivityEventType.PrReviewAccepted, context),
    payload: { revision: command.revision, actorId: command.actorId },
  });

export const reviewAcceptanceSignalRecorded = (
  command: AcceptReviewSignal,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.ReviewAcceptanceSignalRecorded> =>
  fact({
    ...metadata(ActivityEventType.ReviewAcceptanceSignalRecorded, context),
    payload: {
      revision: command.revision,
      actorId: command.actorId,
      actorKind: command.actorKind,
      acceptedEventId: `${context.commandId}:${ActivityEventType.PrReviewAccepted}`,
      providerEventId: command.acceptedEventId,
      trusted: isReviewAuthorized(command),
    },
  });

export const reviewChangesRequested = (
  command: RequestChangesSignal,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrReviewChangesRequested> =>
  fact({
    ...metadata(ActivityEventType.PrReviewChangesRequested, context),
    payload: { revision: command.revision, actorId: command.actorId },
  });

export const reviewRejected = (
  resourceId: ObservePullRequest['resourceId'],
  reason: ActivityEventPayloads[typeof ActivityEventType.PrReviewRejected]['reason'],
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrReviewRejected> =>
  fact({ ...metadata(ActivityEventType.PrReviewRejected, context), payload: { reason } });

export const mergeDenied = (
  reason: PullRequestDenialPayload['reason'],
  context: CommandContext,
  audit: DenialAudit = {},
): ActivityEventDataOf<typeof ActivityEventType.PrMergeDenied> =>
  fact({
    ...metadata(ActivityEventType.PrMergeDenied, context),
    payload: denialPayload(ActivityEventType.PrMergeDenied, reason, context, audit),
  });

export const approveDenied = (
  reason: PullRequestDenialPayload['reason'],
  context: CommandContext,
  audit: DenialAudit = {},
): ActivityEventDataOf<typeof ActivityEventType.PrApproveDenied> =>
  fact({
    ...metadata(ActivityEventType.PrApproveDenied, context),
    payload: denialPayload(ActivityEventType.PrApproveDenied, reason, context, audit),
  });

export const mergeAuthorized = (
  revision: string,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrMergeAuthorized> =>
  fact({
    ...metadata(ActivityEventType.PrMergeAuthorized, context),
    payload: { revision },
  });

export function deliveryIntentRequested(
  resourceId: ObservePullRequest['resourceId'],
  type: typeof ActivityEventType.PrApproveRequested,
  payload: Omit<
    ActivityEventPayloads[typeof ActivityEventType.PrApproveRequested],
    'idempotencyKey'
  >,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrApproveRequested>;

export function deliveryIntentRequested(
  resourceId: ObservePullRequest['resourceId'],
  type: typeof ActivityEventType.PrMergeRequested,
  payload: Omit<ActivityEventPayloads[typeof ActivityEventType.PrMergeRequested], 'idempotencyKey'>,
  context: CommandContext,
): ActivityEventDataOf<typeof ActivityEventType.PrMergeRequested>;

export function deliveryIntentRequested(
  resourceId: ObservePullRequest['resourceId'],
  type: DeliveryIntentType,
  payload:
    | Omit<ActivityEventPayloads[typeof ActivityEventType.PrApproveRequested], 'idempotencyKey'>
    | Omit<ActivityEventPayloads[typeof ActivityEventType.PrMergeRequested], 'idempotencyKey'>,
  context: CommandContext,
): ActivityEventData {
  void resourceId;
  if (type === ActivityEventType.PrApproveRequested) {
    if (!('body' in payload)) throw new Error('Approve intents require a body');
    return fact({
      ...metadata(ActivityEventType.PrApproveRequested, context),
      payload: { idempotencyKey: `${context.commandId}:${type}`, ...payload },
    });
  }
  if ('body' in payload) throw new Error('Merge intents must not carry a body');
  return fact({
    ...metadata(ActivityEventType.PrMergeRequested, context),
    payload: { idempotencyKey: `${context.commandId}:${type}`, ...payload },
  });
}

type PullRequestFactType = Exclude<
  ActivityEventData['eventType'],
  | typeof ActivityEventType.IssueCompleteRequested
  | typeof ActivityEventType.PrApproveDecisionClaimed
  | typeof ActivityEventType.PrMergeDecisionClaimed
>;

type PullRequestFactInput<Type extends PullRequestFactType> = Extract<
  ActivityEventDataInput,
  { readonly eventType: Type }
>;

function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrDiscovered>,
): ActivityEventDataOf<typeof ActivityEventType.PrDiscovered>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrRevisionChanged>,
): ActivityEventDataOf<typeof ActivityEventType.PrRevisionChanged>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrStateChanged>,
): ActivityEventDataOf<typeof ActivityEventType.PrStateChanged>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrChecksChanged>,
): ActivityEventDataOf<typeof ActivityEventType.PrChecksChanged>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrReviewAccepted>,
): ActivityEventDataOf<typeof ActivityEventType.PrReviewAccepted>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.ReviewAcceptanceSignalRecorded>,
): ActivityEventDataOf<typeof ActivityEventType.ReviewAcceptanceSignalRecorded>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrReviewChangesRequested>,
): ActivityEventDataOf<typeof ActivityEventType.PrReviewChangesRequested>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrReviewRejected>,
): ActivityEventDataOf<typeof ActivityEventType.PrReviewRejected>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrMergeDenied>,
): ActivityEventDataOf<typeof ActivityEventType.PrMergeDenied>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrApproveDenied>,
): ActivityEventDataOf<typeof ActivityEventType.PrApproveDenied>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrMergeAuthorized>,
): ActivityEventDataOf<typeof ActivityEventType.PrMergeAuthorized>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrApproveRequested>,
): ActivityEventDataOf<typeof ActivityEventType.PrApproveRequested>;
function fact(
  input: PullRequestFactInput<typeof ActivityEventType.PrMergeRequested>,
): ActivityEventDataOf<typeof ActivityEventType.PrMergeRequested>;

function fact(
  input: Extract<ActivityEventDataInput, { readonly eventType: PullRequestFactType }>,
): Extract<ActivityEventData, { readonly eventType: PullRequestFactType }> {
  const event = createActivityEventData(input);
  switch (event.eventType) {
    case ActivityEventType.IssueCompleteRequested:
    case ActivityEventType.PrApproveDecisionClaimed:
    case ActivityEventType.PrMergeDecisionClaimed:
      throw new Error(`Unexpected non-PR-fact event ${event.eventType}`);
    default:
      return event;
  }
}

function denialPayload(
  eventType: typeof ActivityEventType.PrMergeDenied | typeof ActivityEventType.PrApproveDenied,
  reason: PullRequestDenialPayload['reason'],
  context: CommandContext,
  audit: DenialAudit,
) {
  return {
    activationId: activationId(context.commandId),
    idempotencyKey: `${context.commandId}:${eventType}`,
    reason,
    ...audit,
  };
}

function metadata<Type extends ActivityEventData['eventType']>(
  eventType: Type,
  context: CommandContext,
) {
  return {
    eventId: `${context.commandId}:${eventType}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'activities-pr' },
  };
}
