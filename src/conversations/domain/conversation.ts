import type { ConversationEvent } from '../contracts/events.js';
import { ConversationEventType } from '../contracts/events.js';
import type { ConversationView } from '../contracts/views.js';

export function foldConversation(events: readonly ConversationEvent[]): ConversationView | null {
  let view: ConversationView | null = null;
  for (const event of events) {
    switch (event.eventType) {
      case ConversationEventType.Created:
        view = { conversationId: event.stream.id, workItemId: event.payload.workItemId, entries: [], resources: [] };
        break;
      case ConversationEventType.EntryRecorded:
        view = appendEntry(view as ConversationView | null, event);
        break;
    }
  }
  return view;
}

function appendEntry(view: ConversationView | null, event: Extract<ConversationEvent, { readonly eventType: typeof ConversationEventType.EntryRecorded }>): ConversationView | null {
  if (view === null || view.entries.some((entry) => entry.entryId === event.payload.entryId)) return view;
  return { ...view, entries: [...view.entries, { entryId: event.payload.entryId, body: event.payload.body, occurredAt: event.occurredAt, origin: event.payload.origin }] };
}
