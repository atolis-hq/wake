import { createEventData, type EventDataInput } from '@atolis-hq/eventing';
import { ControlEventType, type ControlEventData, type ControlEventPayloads } from './events.js';

export type ControlPlaneEventDataInput = {
  [Type in keyof ControlEventPayloads]: EventDataInput<Type, ControlEventPayloads[Type]>;
}[keyof ControlEventPayloads];

export function createControlPlaneEventData(input: ControlPlaneEventDataInput): ControlEventData {
  switch (input.eventType) {
    case ControlEventType.TriggerRequestRecorded:
      return createEventData(input);
    case ControlEventType.TriggerInvocationClaimed:
      return createEventData(input);
    case ControlEventType.TriggerPaused:
      return createEventData(input);
    case ControlEventType.TriggerResumed:
      return createEventData(input);
    case ControlEventType.TriggerInvocationFinished:
      return createEventData(input);
    case ControlEventType.TriggerInvocationStarted:
      return createEventData(input);
    case ControlEventType.DispatchPaused:
      return createEventData(input);
    case ControlEventType.DispatchResumed:
      return createEventData(input);
    case ControlEventType.RunnerPaused:
      return createEventData(input);
    case ControlEventType.RunnerResumed:
      return createEventData(input);
  }
}
