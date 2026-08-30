import { createEventData, type EventDataInput } from '../../kernel/index.js';
import { ResourceEventType, type ResourceEventData, type ResourceEventPayloads } from './events.js';

export type ResourceEventDataInput = {
  [Type in keyof ResourceEventPayloads]: EventDataInput<Type, ResourceEventPayloads[Type]>;
}[keyof ResourceEventPayloads];

// Exhaustive dispatch preserves the closed event-to-payload mapping.
// eslint-disable-next-line complexity
export function createResourceEventData(input: ResourceEventDataInput): ResourceEventData {
  switch (input.eventType) {
    case ResourceEventType.ResourceDiscovered:
      return createEventData(input);
    case ResourceEventType.ResourceRevisionObserved:
      return createEventData(input);
    case ResourceEventType.WorkCorrelationEstablished:
      return createEventData(input);
    case ResourceEventType.WorkCorrelationRetracted:
      return createEventData(input);
    case ResourceEventType.WorkCorrelationConflicted:
      return createEventData(input);
    case ResourceEventType.WorkCorrelationRetryPending:
      return createEventData(input);
    case ResourceEventType.WorkCorrelationUnresolvable:
      return createEventData(input);
    case ResourceEventType.ExternalOutcomeObserved:
      return createEventData(input);
    case ResourceEventType.ExternalOutcomeReopened:
      return createEventData(input);
    case ResourceEventType.ExternalOutcomeConsumed:
      return createEventData(input);
    case ResourceEventType.IssueCompletionObservationConsumed:
      return createEventData(input);
    case ResourceEventType.IssueCompletionObservationSuperseded:
      return createEventData(input);
  }
}
