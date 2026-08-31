import { createEventData, type EventDataInput } from '@atolis-hq/eventing';
import { WorkEventType, type WorkEventData, type WorkEventPayloads } from './events.js';

export type WorkEventDataInput = {
  [Type in keyof WorkEventPayloads]: EventDataInput<Type, WorkEventPayloads[Type]>;
}[keyof WorkEventPayloads];

export function createWorkEventData(input: WorkEventDataInput): WorkEventData {
  switch (input.eventType) {
    case WorkEventType.ItemCreated:
      return createEventData(input);
    case WorkEventType.ObjectiveRevised:
      return createEventData(input);
    case WorkEventType.ItemLinked:
      return createEventData(input);
    case WorkEventType.ItemClosed:
      return createEventData(input);
    case WorkEventType.ItemCancelled:
      return createEventData(input);
    case WorkEventType.AutoApprovalGranted:
      return createEventData(input);
    case WorkEventType.AutoApprovalRevoked:
      return createEventData(input);
    case WorkEventType.ItemFrozen:
      return createEventData(input);
    case WorkEventType.ItemUnfrozen:
      return createEventData(input);
    case WorkEventType.ItemDeleted:
      return createEventData(input);
  }
}
