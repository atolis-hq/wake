import {
  activationSchedulerCriticalSectionConsumer,
  type ActivationSchedulerSerialiser,
} from '../control-plane/index.js';
import { createFileProcessorRunSerialiser } from '../persistence/index.js';

const defaultSignal = new AbortController().signal;

/** Adapts the durable keyed file lock to the control-plane scheduler boundary. */
export function createFileActivationSchedulerSerialiser(
  dataRoot: string,
): ActivationSchedulerSerialiser {
  const serialise = createFileProcessorRunSerialiser(dataRoot);
  return (operation, signal = defaultSignal) =>
    serialise(activationSchedulerCriticalSectionConsumer, signal, operation);
}
