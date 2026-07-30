import type { ActivityOutcome, WaitingActivityOutcome } from '../../activities/index.js';
import type { EventDraft } from '../../kernel/index.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { stateDraft } from './decision-events.js';

interface WaitingInput {
  readonly activationId: string;
  readonly outcome: ActivityOutcome;
  readonly occurredAt: string;
  readonly causationId: string;
}

export function acceptWaitingOutcome(
  state: WorkflowInstanceView,
  input: WaitingInput,
):
  | { readonly kind: 'append'; readonly events: readonly EventDraft[] }
  | { readonly kind: 'ignored'; readonly reason: string } {
  const waiting = waitingOutcome(input.outcome);
  if (waiting === null) return { kind: 'ignored', reason: 'waiting outcome lacks expectation' };
  if (
    state.pendingActivation?.status === 'waiting' &&
    state.waitingFor?.intentEventId === waiting.data.intentEventId &&
    state.waitingFor.signalKind === waiting.data.signalKind
  )
    return { kind: 'ignored', reason: 'waiting outcome was already recorded' };
  return {
    kind: 'append',
    events: [
      stateDraft(
        state,
        input,
        'activity-waiting',
        { activationId: input.activationId, ...waiting.data, outcome: waiting },
        1,
      ),
    ],
  };
}

function waitingOutcome(outcome: ActivityOutcome): WaitingActivityOutcome | null {
  if (outcome.kind !== 'waiting' || typeof outcome.data !== 'object' || outcome.data === null)
    return null;
  const data = outcome.data as Record<string, unknown>;
  if (
    typeof data.intentEventId !== 'string' ||
    data.intentEventId.length === 0 ||
    typeof data.signalKind !== 'string' ||
    data.signalKind.length === 0
  )
    return null;
  return {
    kind: 'waiting',
    data: { intentEventId: data.intentEventId, signalKind: data.signalKind },
  };
}
