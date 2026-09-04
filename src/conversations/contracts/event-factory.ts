import { createEventData, type EventDataInput } from '@atolis-hq/eventing';
import {
  ConversationEventType,
  type ConversationEventData,
  type ConversationEventPayloads,
} from './events.js';

export type ConversationEventDataInput = {
  [Type in keyof ConversationEventPayloads]: EventDataInput<Type, ConversationEventPayloads[Type]>;
}[keyof ConversationEventPayloads];

export function createConversationEventData(
  input: ConversationEventDataInput,
): ConversationEventData {
  switch (input.eventType) {
    case ConversationEventType.Created:
      return createEventData(input);
    case ConversationEventType.ResourceAssociated:
      return createEventData(input);
    case ConversationEventType.EntryRecorded:
      return createEventData(input);
    case ConversationEventType.EntryRevised:
      return createEventData(input);
    case ConversationEventType.EntryTombstoned:
      return createEventData(input);
    case ConversationEventType.EntryRepresentationRecorded:
      return createEventData(input);
  }
}
