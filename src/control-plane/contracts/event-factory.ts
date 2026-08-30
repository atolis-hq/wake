import {
  createEventData,
  EventSourceKind,
  type CommandContext,
  type EventDataInput,
} from '../../kernel/index.js';
import { ControlEventType, type ControlEventData, type ControlEventPayloads } from './events.js';
import { ControlStreamKind } from './streams.js';

export type ControlPlaneEventDataInput = {
  [Type in keyof ControlEventPayloads]: EventDataInput<Type, ControlEventPayloads[Type]>;
}[keyof ControlEventPayloads];

export function createControlPlaneEventData(input: ControlPlaneEventDataInput): ControlEventData {
  switch (input.eventType) {
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

export function createControlEventData<Type extends keyof ControlEventPayloads>(
  eventType: Type,
  payload: ControlEventPayloads[Type],
  context: CommandContext,
) {
  return createEventData({
    eventId: `${context.commandId}:${eventType}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
    payload,
  });
}
