import {
  activationSchedulerCriticalSectionConsumer,
  type ActivationSchedulerSerialiser,
} from '../control-plane/index.js';
import { createFileSubscriptionRunSerialiser } from '../persistence/index.js';

const defaultSignal = new AbortController().signal;

/** Adapts the durable keyed file lock to the control-plane scheduler boundary. */
export function createFileActivationSchedulerSerialiser(
  dataRoot: string,
): ActivationSchedulerSerialiser {
  const serialise = createFileSubscriptionRunSerialiser(dataRoot);
  return (operation, signal = defaultSignal) =>
    serialise(activationSchedulerCriticalSectionConsumer, signal, operation);
}
