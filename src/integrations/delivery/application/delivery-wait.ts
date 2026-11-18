import { activationId } from '../../../activities/index.js';
import {
  ActivityActivationStatus,
  type WorkflowInstanceView,
} from '../../../orchestration/index.js';

const deliveryResultSignalKind = 'delivery-result';

export const DeliveryWait = {
  /** The activation is waiting for exactly this delivery. */
  Awaiting: 'awaiting',
  /** The activation is still current (or unknown), so its wait may simply not be recorded yet. */
  NotYet: 'not-yet',
  /** The activation already settled, so this outcome can never be accepted. */
  Settled: 'settled',
} as const;

export type DeliveryWait = (typeof DeliveryWait)[keyof typeof DeliveryWait];

type WaitView = Pick<
  WorkflowInstanceView,
  'pendingActivation' | 'waitingFor' | 'acceptedOutcomes'
> | null;

export function classifyDeliveryWait(
  view: WaitView,
  activation: string,
  intentEventId: string,
): DeliveryWait {
  const pending = view?.pendingActivation;
  if (view === null) return DeliveryWait.NotYet;
  if (pending?.activationId === activation)
    return pending.status === ActivityActivationStatus.Waiting &&
      view.waitingFor?.signalKind === deliveryResultSignalKind &&
      view.waitingFor.intentEventId === intentEventId
      ? DeliveryWait.Awaiting
      : DeliveryWait.NotYet;
  // A different activation is current, or this one's outcome was already accepted.
  return pending !== undefined || view.acceptedOutcomes.includes(activationId(activation))
    ? DeliveryWait.Settled
    : DeliveryWait.NotYet;
}
