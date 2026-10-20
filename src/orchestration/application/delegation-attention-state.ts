import type { CommandContext } from '@atolis-hq/eventing';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ActivityOutcomeKind, type ActivityOutcome } from '../../activities/index.js';
import {
  DelegationAttentionError,
  type DelegationAttentionBlocker,
  type DelegationAttentionReply,
  type DelegationAttentionRequest,
  type DelegationAttentionResponse,
  type DelegationCaller,
  type DelegationReservation,
} from '../contracts/delegation.js';
import type { WorkflowOrchestrationEventData } from '../contracts/events.js';
import { OrchestrationEventType, type WorkflowOrchestrationEvent } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationAttentionRejection,
  DelegationBlockerKind,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { isNeedsClarificationResumeEligible } from '../domain/interpreter.js';
import { delegationDraft } from './delegation-ledger.js';

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

export const MaxAssessmentAttempts = 3;

const structuredBlockSchema = z
  .object({
    status: z.string().min(1),
    message: z.string().optional(),
    question: z.string().optional(),
    unverifiedCompletionReason: z.string().optional(),
  })
  .passthrough();
const failureDataSchema = z
  .object({ reason: z.string().optional(), message: z.string().optional() })
  .passthrough();

/**
 * A structured blocked/needs-clarification result, or a deliberate `FAILED` the agent reports
 * itself, is a human-visible escalation. A failed, rejected or infrastructure-blocked run (runner
 * failure, authentication, ambiguous or unverified completion) is only a failed assessment: it
 * must never cancel or settle the cohort.
 */
export function attentionVerdict(outcome: ActivityOutcome): AttentionVerdict {
  if (outcome.kind === ActivityOutcomeKind.Done) return {};
  const question = humanQuestion(outcome);
  return question === undefined
    ? { failure: runFailure(outcome) }
    : { escalation: question, outcome };
}

/** The agent's own structured block or failure, unless the run could not verify completion. */
function humanQuestion(outcome: ActivityOutcome): string | undefined {
  if (outcome.kind !== ActivityOutcomeKind.Blocked && outcome.kind !== ActivityOutcomeKind.Failed)
    return undefined;
  const parsed = structuredBlockSchema.safeParse(outcome.data);
  if (!parsed.success || parsed.data.unverifiedCompletionReason !== undefined) return undefined;
  return parsed.data.question ?? parsed.data.message ?? parsed.data.status;
}

function runFailure(outcome: ActivityOutcome): string {
  const structured = structuredBlockSchema.safeParse(outcome.data);
  if (structured.success && structured.data.unverifiedCompletionReason !== undefined)
    return structured.data.unverifiedCompletionReason;
  const detail = failureDataSchema.safeParse(outcome.data);
  return (detail.success ? (detail.data.reason ?? detail.data.message) : undefined) ?? outcome.kind;
}

/** How the parent's assessment ended; only a human question or a failed run is more than `done`. */
export interface AttentionVerdict {
  /** The batched human question, published as an ordinary accepted agent outcome. */
  readonly escalation?: string;
  /** The assessment run itself failed (runner, transport or invalid result). */
  readonly failure?: string;
  /** Set by the ledger when this failure used the last allowed assessment attempt. */
  readonly exhausted?: boolean;
  readonly outcome?: ActivityOutcome;
}

/** Resolution never settles the cohort: it restores the wait, with the outcome when it asks a human. */
export function resolutionDrafts(
  context: CommandContext,
  parentId: WorkflowInstanceId,
  attention: NonNullable<WorkflowInstanceView['delegationAttention']>,
  verdict: AttentionVerdict,
): WorkflowOrchestrationEventData[] {
  const drafts: WorkflowOrchestrationEventData[] = [];
  if (verdict.escalation !== undefined && verdict.outcome !== undefined)
    drafts.push(
      delegationDraft(
        context,
        `attention-outcome:${attention.activationId}`,
        {
          eventType: OrchestrationEventType.ActivityOutcomeAccepted,
          payload: { activationId: attention.activationId, outcome: verdict.outcome },
        },
        parentId,
      ),
    );
  drafts.push(
    delegationDraft(
      context,
      `attention-resolved:${attention.activationId}`,
      {
        eventType: OrchestrationEventType.DelegationAttentionResolved,
        payload: {
          cohortId: attention.cohortId,
          attentionKey: attention.attentionKey,
          activationId: attention.activationId,
          ...(verdict.escalation === undefined ? {} : { escalation: verdict.escalation }),
          ...(verdict.failure === undefined ? {} : { assessmentFailure: verdict.failure }),
        },
      },
      parentId,
    ),
  );
  if (verdict.failure !== undefined)
    drafts.push(
      delegationDraft(
        context,
        `attention-failed:${attention.activationId}`,
        {
          eventType: OrchestrationEventType.DelegationReconciliationFailed,
          payload: {
            cohortId: attention.cohortId,
            reason: `Parent attention assessment failed (${verdict.failure}); the cohort is unchanged`,
          },
        },
        parentId,
      ),
    );
  // The last allowed retry leaves one inspectable operator escalation, not a quiet stop.
  if (verdict.failure !== undefined && verdict.exhausted === true)
    drafts.push(
      delegationDraft(
        context,
        `attention-exhausted:${digest(attention.attentionKey)}`,
        {
          eventType: OrchestrationEventType.DelegationReconciliationFailed,
          payload: {
            cohortId: attention.cohortId,
            reason: `Parent attention assessment failed ${MaxAssessmentAttempts} times (${verdict.failure}); an operator must inspect the blockers`,
          },
        },
        parentId,
      ),
    );
  return drafts;
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
  // A failed assessment run leaves its blockers unassessed so a later pass re-raises them, but
  // only a bounded number of times: repeated failures stay visible as diagnostics, never a loop.
  const failures = new Map<string, number>();
  const resolved = new Set<string>();
  for (const { event } of ours) {
    if (event.eventType !== OrchestrationEventType.DelegationAttentionResolved) continue;
    const key = event.payload.attentionKey;
    if (event.payload.assessmentFailure === undefined) resolved.add(key);
    else {
      failures.set(key, (failures.get(key) ?? 0) + 1);
      if ((failures.get(key) ?? 0) >= MaxAssessmentAttempts) resolved.add(key);
    }
  }
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
