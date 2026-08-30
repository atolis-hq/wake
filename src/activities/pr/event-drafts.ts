import { createEventData, EventSourceKind, type CommandContext } from '../../kernel/index.js';
import { resourceStream, type ResourceStreamRef } from '../../resources/index.js';
import type { WorkItemStreamRef } from '../../work/index.js';
import {
  ActivityEventType,
  type ActivityEventData,
  type ActivityEventPayloads,
  type PullRequestDenialPayload,
} from '../contracts/events.js';
import { activationId } from '../contracts/identifiers.js';
import { isReviewAuthorized } from '../review/authorization.js';
import type { AcceptReviewSignal, ObservePullRequest, RequestChangesSignal } from './contracts.js';

type ActivityDraft<Type extends ActivityEventData['eventType']> = Extract<
  ActivityEventData,
  { eventType: Type }
>;

type DenialAudit = Omit<PullRequestDenialPayload, 'activationId' | 'idempotencyKey' | 'reason'>;

type DeliveryIntentType =
  typeof ActivityEventType.PrApproveRequested | typeof ActivityEventType.PrMergeRequested;

export const discovered = (
  { resourceId, ...command }: ObservePullRequest,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrDiscovered> =>
  fact(resourceId, ActivityEventType.PrDiscovered, command, context);

export const revisionChanged = (
  command: ObservePullRequest,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrRevisionChanged> =>
  fact(
    command.resourceId,
    ActivityEventType.PrRevisionChanged,
    {
      headRevision: command.headRevision,
      baseRevision: command.baseRevision,
      ...(command.changedFiles === undefined ? {} : { changedFiles: command.changedFiles }),
    },
    context,
  );

export const stateChanged = (
  command: ObservePullRequest,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrStateChanged> =>
  fact(command.resourceId, ActivityEventType.PrStateChanged, { state: command.state }, context);

export const checksChanged = (
  command: ObservePullRequest,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrChecksChanged> =>
  fact(command.resourceId, ActivityEventType.PrChecksChanged, { checks: command.checks }, context);

export const reviewAccepted = (
  command: AcceptReviewSignal,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrReviewAccepted> =>
  fact(
    command.resourceId,
    ActivityEventType.PrReviewAccepted,
    { revision: command.revision, actorId: command.actorId },
    context,
  );

export const reviewAcceptanceSignalRecorded = (
  command: AcceptReviewSignal,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.ReviewAcceptanceSignalRecorded> =>
  fact(
    command.resourceId,
    ActivityEventType.ReviewAcceptanceSignalRecorded,
    {
      revision: command.revision,
      actorId: command.actorId,
      actorKind: command.actorKind,
      acceptedEventId: `${context.commandId}:${ActivityEventType.PrReviewAccepted}`,
      providerEventId: command.acceptedEventId,
      trusted: isReviewAuthorized(command),
    },
    context,
  );

export const reviewChangesRequested = (
  command: RequestChangesSignal,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrReviewChangesRequested> =>
  fact(
    command.resourceId,
    ActivityEventType.PrReviewChangesRequested,
    { revision: command.revision, actorId: command.actorId },
    context,
  );

export const reviewRejected = (
  resourceId: ObservePullRequest['resourceId'],
  reason: ActivityEventPayloads[typeof ActivityEventType.PrReviewRejected]['reason'],
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrReviewRejected> =>
  fact(resourceId, ActivityEventType.PrReviewRejected, { reason }, context);

export const mergeDenied = (
  stream: ResourceStreamRef | WorkItemStreamRef,
  reason: PullRequestDenialPayload['reason'],
  context: CommandContext,
  audit: DenialAudit = {},
): ActivityDraft<typeof ActivityEventType.PrMergeDenied> =>
  denialDraft(ActivityEventType.PrMergeDenied, stream, reason, context, audit);

export const approveDenied = (
  stream: ResourceStreamRef | WorkItemStreamRef,
  reason: PullRequestDenialPayload['reason'],
  context: CommandContext,
  audit: DenialAudit = {},
): ActivityDraft<typeof ActivityEventType.PrApproveDenied> =>
  denialDraft(ActivityEventType.PrApproveDenied, stream, reason, context, audit);

export const mergeAuthorized = (
  stream: ResourceStreamRef,
  revision: string,
  context: CommandContext,
): ActivityDraft<typeof ActivityEventType.PrMergeAuthorized> =>
  createEventData({
    ...metadata(ActivityEventType.PrMergeAuthorized, context),
    stream,
    payload: { revision },
  });

export const deliveryIntentRequested = <Type extends DeliveryIntentType>(
  resourceId: ObservePullRequest['resourceId'],
  type: Type,
  payload: Omit<ActivityEventPayloads[Type], 'idempotencyKey'>,
  context: CommandContext,
) =>
  createEventData({
    ...metadata(type, context),
    stream: resourceStream(resourceId),
    payload: { idempotencyKey: `${context.commandId}:${type}`, ...payload },
  });

function fact<Type extends ActivityEventData['eventType']>(
  resourceId: ObservePullRequest['resourceId'],
  eventType: Type,
  payload: ActivityEventPayloads[Type],
  context: CommandContext,
) {
  return createEventData({
    ...metadata(eventType, context),
    stream: resourceStream(resourceId),
    payload,
  });
}

function denialDraft<
  Type extends typeof ActivityEventType.PrMergeDenied | typeof ActivityEventType.PrApproveDenied,
>(
  eventType: Type,
  stream: ResourceStreamRef | WorkItemStreamRef,
  reason: PullRequestDenialPayload['reason'],
  context: CommandContext,
  audit: DenialAudit,
) {
  return createEventData({
    ...metadata(eventType, context),
    stream,
    payload: {
      activationId: activationId(context.commandId),
      idempotencyKey: `${context.commandId}:${eventType}`,
      reason,
      ...audit,
    },
  });
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
