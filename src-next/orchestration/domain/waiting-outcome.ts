import { ActivityOutcomeKind, type ActivationId } from '../../activities/index.js';
import { ActivityActivationStatus } from '../contracts/vocabulary.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stateDraft } from './decision-events.js';
import type {
  OrchestrationActivityOutcome,
  OrchestrationWaitingActivityOutcome,
} from '../contracts/activity-outcome.js';

interface WaitingInput {
  readonly activationId: ActivationId;
  readonly outcome: OrchestrationActivityOutcome;
  readonly occurredAt: string;
  readonly causationId: string;
}

export function acceptWaitingOutcome(
  state: WorkflowInstanceView,
  input: WaitingInput,
):
  | { readonly kind: 'append'; readonly events: readonly WorkflowOrchestrationEventDraft[] }
  | { readonly kind: 'ignored'; readonly reason: string } {
  const waiting = waitingOutcome(input.outcome);
  if (waiting === null) return { kind: 'ignored', reason: 'waiting outcome lacks expectation' };
  if (
    state.pendingActivation?.status === ActivityActivationStatus.Waiting &&
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
        OrchestrationEventType.ActivityWaiting,
        { activationId: input.activationId, outcome: waiting },
        1,
      ),
    ],
  };
}

function waitingOutcome(
  outcome: OrchestrationActivityOutcome,
): OrchestrationWaitingActivityOutcome | null {
  return outcome.kind === ActivityOutcomeKind.Waiting
    ? (outcome as OrchestrationWaitingActivityOutcome)
    : null;
}
