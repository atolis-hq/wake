import { createEventData, type EventDataInput } from '../../../kernel/index.js';
import type { DeliveryStreamRef } from '../../contracts/streams.js';
import { DeliveryEventType, type DeliveryEventData, type DeliveryEventPayloads } from './events.js';

export type DeliveryEventDataInput = {
  [Type in keyof DeliveryEventPayloads]: EventDataInput<
    Type,
    DeliveryEventPayloads[Type],
    DeliveryStreamRef
  >;
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
