import { createHash } from 'node:crypto';
import { ActivityOutcomeKind } from '../../activities/index.js';
import {
  DelegationAttentionError,
  type DelegationAttentionBlocker,
  type DelegationAttentionReply,
  type DelegationAttentionRequest,
  type DelegationAttentionResponse,
  type DelegationCaller,
  type DelegationReservation,
} from '../contracts/delegation.js';
import { OrchestrationEventType, type WorkflowOrchestrationEvent } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationAttentionRejection,
  DelegationBlockerKind,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { isNeedsClarificationResumeEligible } from '../domain/interpreter.js';

type Child = DelegationReservation['children'][number];

export type OpenAttention = DelegationAttentionRequest & {
  readonly responses: readonly DelegationAttentionResponse[];
};

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export const failedBlockerId = (child: Child) => `${child.grantId}:failed`;

/** Only a child blocked on an agent clarification (never a human gate) is answerable. */
export function contextBlockerId(child: Child, view: WorkflowInstanceView): string | undefined {
  if (view.status !== WorkflowStatus.Blocked || !isNeedsClarificationResumeEligible(view))
    return undefined;
  const pending = view.pendingActivation;
  return pending === undefined ? undefined : `${child.grantId}:context:${pending.activationId}`;
}

/**
 * A child parked by its own routing: blocked (for example retries exhausted) or waiting on a
 * human route after a failed outcome. Identified by the activation it is parked on.
 */
export function parkedBlockerId(child: Child, view: WorkflowInstanceView): string | undefined {
  const pending = view.pendingActivation;
  if (pending === undefined) return undefined;
  const parked =
    view.status === WorkflowStatus.Blocked ||
    (view.status === WorkflowStatus.Waiting &&
      view.waitingFor !== undefined &&
      view.lastOutcome?.kind === ActivityOutcomeKind.Failed);
  return parked ? `${child.grantId}:parked:${pending.activationId}` : undefined;
}

/** The unresolved reason for one member, from its recorded blocker or its live workflow state. */
export function blockerOf(
  child: Child,
  recorded: string | undefined,
  view: WorkflowInstanceView | null,
): DelegationAttentionBlocker | undefined {
  const base = { childWorkItemId: child.workItemId };
  if (recorded !== undefined)
    return {
      ...base,
      blockerId: failedBlockerId(child),
      kind: DelegationBlockerKind.Failed,
      reason: recorded,
    };
  if (view === null) return undefined;
  const context = contextBlockerId(child, view);
  if (context !== undefined)
    return {
      ...base,
      blockerId: context,
      kind: DelegationBlockerKind.Context,
      reason: view.blockReason ?? 'Child needs assignment clarification',
    };
  const parked = parkedBlockerId(child, view);
  return parked === undefined
    ? undefined
    : {
        ...base,
        blockerId: parked,
        kind: DelegationBlockerKind.Failed,
        reason: view.blockReason ?? 'Child is parked after a failed outcome',
      };
}

/** Blockers already put to a parent assessment; each is raised once, never polled. */
export function assessedBlockers(
  events: readonly WorkflowOrchestrationEvent[],
  reservation: DelegationReservation,
): ReadonlySet<string> {
  const ours = events.filter(
    ({ stream, event }) =>
      stream.id === reservation.parentWorkflowInstanceId &&
      'cohortId' in event.payload &&
      event.payload.cohortId === reservation.cohortId,
  );
  const resolved = new Set(
    ours.flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationAttentionResolved
        ? [event.payload.attentionKey]
        : [],
    ),
  );
  return new Set(
    ours.flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationAttentionRequested &&
      resolved.has(event.payload.attentionKey)
        ? event.payload.blockers.map((blocker) => blocker.blockerId)
        : [],
    ),
  );
}

export function attentionKeyOf(
  reservation: DelegationReservation,
  blockerIds: readonly string[],
): string {
  return `${reservation.cohortId}@${reservation.planRevision ?? 1}:${[...blockerIds].sort().join(',')}`;
}

export function reject(code: DelegationAttentionRejection, message: string) {
  return new DelegationAttentionError(code, message);
}

/**
 * Every boundary Wake relies on before accepting a reply: the Run-bound activation, the exact
 * blocker and its kind, and the assignment revision. Returns the earlier identical reply, if any.
 */
export function assertReplyAllowed(
  parent: WorkflowInstanceView,
  attention: OpenAttention | null,
  caller: DelegationCaller,
  reply: DelegationAttentionReply,
): DelegationAttentionResponse | undefined {
  if (attention === null || parent.delegationAttention?.activationId !== caller.activationId)
    throw reject(
      DelegationAttentionRejection.NoAttention,
      'No parent attention is open for this activation',
    );
  const blocker = attention.blockers.find(
    (entry) =>
      entry.blockerId === reply.blockerId && entry.childWorkItemId === reply.childWorkItemId,
  );
  if (blocker === undefined)
    throw reject(
      DelegationAttentionRejection.UnknownBlocker,
      'The reply names a child or blocker outside this attention request',
    );
  // Terminal failures and human-only gates are never answered through this channel.
  if (blocker.kind !== DelegationBlockerKind.Context)
    throw reject(
      DelegationAttentionRejection.NotAnswerable,
      'Only an assignment-context blocker accepts a reply; use follow-up work or escalate',
    );
  if (reply.expectedRevision !== attention.revision)
    throw reject(
      DelegationAttentionRejection.StaleRevision,
      'The assignment revision changed; inspect before replying',
    );
  const prior = attention.responses.find((entry) => entry.blockerId === reply.blockerId);
  if (prior !== undefined && JSON.stringify(prior.references) !== JSON.stringify(reply.references))
    throw reject(
      DelegationAttentionRejection.Duplicate,
      'This blocker already has a different accepted reply',
    );
  return prior;
}
