import { createEventDraft, type EventDraftInput } from '../../../kernel/index.js';
import type { DeliveryStreamRef } from '../../contracts/streams.js';
import {
  DeliveryEventType,
  type DeliveryEventDraft,
  type DeliveryEventPayloads,
} from './events.js';

export type DeliveryEventDraftInput = {
  [Type in keyof DeliveryEventPayloads]: EventDraftInput<
    Type,
    DeliveryEventPayloads[Type],
    DeliveryStreamRef
  >;
}[keyof DeliveryEventPayloads];

export function createDeliveryEventDraft(input: DeliveryEventDraftInput): DeliveryEventDraft {
  switch (input.eventType) {
    case DeliveryEventType.AttemptStarted:
      return createEventDraft(input);
    case DeliveryEventType.Confirmed:
      return createEventDraft(input);
    case DeliveryEventType.Failed:
      return createEventDraft(input);
    case DeliveryEventType.Ambiguous:
      return createEventDraft(input);
    case DeliveryEventType.Reconciled:
      return createEventDraft(input);
  }
}
