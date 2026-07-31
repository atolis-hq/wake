import {
  ActivityOutcomeKind,
  type ActivityOutcome,
  type WaitingActivityOutcome,
} from '../../activities/index.js';
import { signalName, type SignalName } from './identifiers.js';

declare const orchestrationActivityOutcomeBrand: unique symbol;

export type OrchestrationActivityOutcome = ActivityOutcome & {
  readonly [orchestrationActivityOutcomeBrand]: true;
};

export type OrchestrationWaitingActivityOutcome = WaitingActivityOutcome & {
  readonly data: WaitingActivityOutcome['data'] & { readonly signalKind: SignalName };
  readonly [orchestrationActivityOutcomeBrand]: true;
};

export function orchestrationActivityOutcome(
  outcome: WaitingActivityOutcome,
): OrchestrationWaitingActivityOutcome;
export function orchestrationActivityOutcome(
  outcome: ActivityOutcome,
): OrchestrationActivityOutcome;
export function orchestrationActivityOutcome(
  outcome: ActivityOutcome,
): OrchestrationActivityOutcome {
  if (outcome.kind !== ActivityOutcomeKind.Waiting) return outcome as OrchestrationActivityOutcome;
  if (typeof outcome.data !== 'object' || outcome.data === null)
    throw new Error('Waiting Activity outcome lacks expectation');
  const intentEventId = Reflect.get(outcome.data, 'intentEventId');
  const rawSignalKind = Reflect.get(outcome.data, 'signalKind');
  if (typeof intentEventId !== 'string' || intentEventId.length === 0)
    throw new Error('Waiting Activity outcome requires intentEventId');
  if (typeof rawSignalKind !== 'string' || rawSignalKind.length === 0)
    throw new Error('Waiting Activity outcome requires signalKind');
  return {
    kind: ActivityOutcomeKind.Waiting,
    data: { intentEventId, signalKind: signalName(rawSignalKind) },
  } as OrchestrationWaitingActivityOutcome;
}
