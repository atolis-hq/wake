import { createEventData, type EventDataInput } from '../../../kernel/index.js';
import { DeliveryEventType, type DeliveryEventData, type DeliveryEventPayloads } from './events.js';
import {
  DeliveryIntentEventType,
  type DeliveryIntentEventData,
  type DeliveryIntentEventPayloads,
} from './intents.js';

export type DeliveryEventDataInput = {
  [Type in keyof DeliveryEventPayloads]: EventDataInput<Type, DeliveryEventPayloads[Type]>;
}[keyof DeliveryEventPayloads];

export function createDeliveryEventData(input: DeliveryEventDataInput): DeliveryEventData {
  switch (input.eventType) {
    case DeliveryEventType.AttemptStarted:
      return createEventData(input);
    case DeliveryEventType.Confirmed:
      return createEventData(input);
    case DeliveryEventType.Failed:
      return createEventData(input);
    case DeliveryEventType.Ambiguous:
      return createEventData(input);
    case DeliveryEventType.Escalated:
      return createEventData(input);
    case DeliveryEventType.Reconciled:
      return createEventData(input);
  }
}

export type DeliveryIntentEventDataInput = {
  [Type in keyof DeliveryIntentEventPayloads]: EventDataInput<
    Type,
    DeliveryIntentEventPayloads[Type]
  >;
}[keyof DeliveryIntentEventPayloads];

export function createDeliveryIntentEventData(
  input: DeliveryIntentEventDataInput,
): DeliveryIntentEventData {
  switch (input.eventType) {
    case DeliveryIntentEventType.StatusPublishRequested:
      return createEventData(input);
    case DeliveryIntentEventType.ReplyPublishRequested:
      return createEventData(input);
    case DeliveryIntentEventType.AgentRunPublishRequested:
      return createEventData(input);
  }
}
