import {
  deliveryAvailability,
  type DeliverySnapshot,
  type DeliveryWorkState,
} from '../../src/work/index.js';

/** A DeliverySnapshot answered by a plain lookup, for tests that script Work state. */
export function snapshotOf(lookup: (id: string) => DeliveryWorkState | null): DeliverySnapshot {
  return {
    get: lookup,
    invalid: () => false,
    availability: (id) => deliveryAvailability(id, lookup),
  };
}
