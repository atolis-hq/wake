import type { ConversationEvent } from '../contracts/events.js';
import { ConversationEventType } from '../contracts/events.js';
import type { ConversationView } from '../contracts/views.js';

export function foldConversation(events: readonly ConversationEvent[]): ConversationView | null { let view: ConversationView | null = null; for (const event of events) { if (event.eventType === ConversationEventType.Created) view = { conversationId: event.stream.id, workItemId: event.payload.workItemId, entries: [], resources: [] }; else if (view !== null && event.eventType === ConversationEventType.EntryRecorded && !view.entries.some((entry) => entry.entryId === event.payload.entryId)) view = { ...view, entries: [...view.entries, { entryId: event.payload.entryId, body: event.payload.body, occurredAt: event.occurredAt, origin: event.payload.origin }] }; } return view; }
