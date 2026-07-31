import {
  createEventDraft,
  type CommandContext,
  type EntityRef,
  type EventDraft,
} from '../../kernel/index.js';
import { resourceStream } from '../../resources/index.js';
import type { AcceptReviewSignal, ObservePullRequest, RequestChangesSignal } from './contracts.js';
import { isReviewAuthorized } from '../review/authorization.js';

export const discovered = (
  { resourceId, ...command }: ObservePullRequest,
  context: CommandContext,
): EventDraft => fact(resourceId, 'pr.discovered', command, context);

export const revisionChanged = (command: ObservePullRequest, context: CommandContext): EventDraft =>
  fact(
    command.resourceId,
    'pr.revision-changed',
    pick(command, ['headRevision', 'baseRevision']),
    context,
  );

export const stateChanged = (command: ObservePullRequest, context: CommandContext): EventDraft =>
  fact(command.resourceId, 'pr.state-changed', pick(command, ['state']), context);

export const checksChanged = (command: ObservePullRequest, context: CommandContext): EventDraft =>
  fact(command.resourceId, 'pr.checks-changed', pick(command, ['checks']), context);

export const reviewAccepted = (command: AcceptReviewSignal, context: CommandContext): EventDraft =>
  fact(command.resourceId, 'pr.review-accepted', pick(command, ['revision', 'actorId']), context);

export const reviewAcceptanceSignalRecorded = (
  command: AcceptReviewSignal,
  context: CommandContext,
): EventDraft =>
  fact(
    command.resourceId,
    'review.acceptance-signal-recorded',
    {
      revision: command.revision,
      actorId: command.actorId,
      actorKind: command.actorKind,
      acceptedEventId: `${context.commandId}:pr.review-accepted`,
      providerEventId: command.acceptedEventId,
      trusted: isReviewAuthorized(command),
    },
    context,
  );

export const reviewChangesRequested = (
  command: RequestChangesSignal,
  context: CommandContext,
): EventDraft =>
  fact(
    command.resourceId,
    'pr.review-changes-requested',
    pick(command, ['revision', 'actorId']),
    context,
  );

export const reviewRejected = (
  resourceId: ObservePullRequest['resourceId'],
  reason: string,
  context: CommandContext,
): EventDraft => fact(resourceId, 'pr.review-rejected', { reason }, context);

export const mergeDenied = (
  stream: EntityRef,
  reason: string,
  context: CommandContext,
  audit: Record<string, unknown> = {},
): EventDraft =>
  createEventDraft({
    eventId: `${context.commandId}:pr.merge-denied`,
    eventType: 'pr.merge-denied',
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: 'internal', id: 'activities-pr' },
    stream,
    payload: {
      activationId: context.commandId,
      idempotencyKey: `${context.commandId}:pr.merge-denied`,
      reason,
      ...audit,
    },
  });

export const approveDenied = (
  stream: EntityRef,
  reason: string,
  context: CommandContext,
  audit: Record<string, unknown> = {},
): EventDraft =>
  createEventDraft({
    eventId: `${context.commandId}:pr.approve-denied`,
    eventType: 'pr.approve-denied',
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: 'internal', id: 'activities-pr' },
    stream,
    payload: {
      activationId: context.commandId,
      idempotencyKey: `${context.commandId}:pr.approve-denied`,
      reason,
      ...audit,
    },
  });

export const mergeAuthorized = (
  stream: EntityRef,
  revision: string,
  context: CommandContext,
): EventDraft =>
  createEventDraft({
    eventId: `${context.commandId}:pr.merge-authorized`,
    eventType: 'pr.merge-authorized',
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: 'internal', id: 'activities-pr' },
    stream,
    payload: { revision },
  });

export const deliveryIntentRequested = (
  resourceId: ObservePullRequest['resourceId'],
  type: 'pr.approve-requested' | 'pr.merge-requested',
  payload: Record<string, unknown>,
  context: CommandContext,
): EventDraft =>
  createEventDraft({
    eventId: `${context.commandId}:${type}`,
    eventType: type,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: 'internal', id: 'activities-pr' },
    stream: resourceStream(resourceId),
    payload: { idempotencyKey: `${context.commandId}:${type}`, ...payload },
  });

function fact<Type extends string, Payload>(
  resourceId: ObservePullRequest['resourceId'],
  eventType: Type,
  payload: Payload,
  context: CommandContext,
): EventDraft {
  return createEventDraft({
    eventId: `${context.commandId}:${eventType}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: 'internal', id: 'activities-pr' },
    stream: resourceStream(resourceId),
    payload,
  });
}

function pick<T extends object, Key extends keyof T>(value: T, keys: readonly Key[]): Pick<T, Key> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, Key>;
}
