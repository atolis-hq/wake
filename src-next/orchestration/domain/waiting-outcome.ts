import {
  ActivityOutcomeKind,
  type ActivityOutcome,
  type ActivationId,
  type WaitingActivityOutcome,
} from '../../activities/index.js';
import { ActivityActivationStatus } from '../contracts/vocabulary.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stateDraft } from './decision-events.js';
import { signalName, type SignalName } from '../contracts/identifiers.js';

interface WaitingInput {
  readonly activationId: ActivationId;
  readonly outcome: ActivityOutcome;
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
        { activationId: input.activationId, ...waiting.data, outcome: waiting },
        1,
      ),
    ],
  };
}

type CompiledWaitingOutcome = WaitingActivityOutcome & {
  readonly data: WaitingActivityOutcome['data'] & { readonly signalKind: SignalName };
};

function waitingOutcome(outcome: ActivityOutcome): CompiledWaitingOutcome | null {
  if (
    outcome.kind !== ActivityOutcomeKind.Waiting ||
    typeof outcome.data !== 'object' ||
    outcome.data === null
  )
    return null;
  const data = outcome.data;
  if (
    !('intentEventId' in data) ||
    typeof data.intentEventId !== 'string' ||
    data.intentEventId.length === 0 ||
    !('signalKind' in data) ||
    typeof data.signalKind !== 'string' ||
    data.signalKind.length === 0
  )
    return null;
  try {
    return {
      kind: ActivityOutcomeKind.Waiting,
      data: { intentEventId: data.intentEventId, signalKind: signalName(data.signalKind) },
    };
  } catch {
    return null;
  }
}
