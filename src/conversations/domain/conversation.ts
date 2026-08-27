import type { ConversationEvent } from '../contracts/events.js';
import { ConversationEventType } from '../contracts/events.js';
import type { ConversationView } from '../contracts/views.js';

export function foldConversation(events: readonly ConversationEvent[]): ConversationView | null {
  let view: ConversationView | null = null;
  for (const event of events) view = applyConversationEvent(view, event);
  return view;
}

export function applyConversationEvent(
  view: ConversationView | null,
  event: ConversationEvent,
): ConversationView | null {
  switch (event.eventType) {
    case ConversationEventType.Created:
      return {
        conversationId: event.stream.id,
        workItemId: event.payload.workItemId,
        entries: [],
        resources: [],
      };
    case ConversationEventType.EntryRecorded:
      return appendEntry(view, event);
    case ConversationEventType.ResourceAssociated:
      return appendResource(view, event);
    case ConversationEventType.EntryRevised:
      return reviseEntry(view, event);
    case ConversationEventType.EntryTombstoned:
      return tombstoneEntry(view, event);
  }
}

function appendEntry(
  view: ConversationView | null,
  event: Extract<
    ConversationEvent,
    { readonly eventType: typeof ConversationEventType.EntryRecorded }
  >,
): ConversationView | null {
  if (view === null || view.entries.some((entry) => entry.entryId === event.payload.entryId))
    return view;
  return {
    ...view,
    entries: [
      ...view.entries,
      {
        entryId: event.payload.entryId,
        body: event.payload.body,
        occurredAt: event.occurredAt,
        origin: event.payload.origin,
        deleted: false,
        revisions: [{ body: event.payload.body, occurredAt: event.occurredAt }],
      },
    ],
  };
}

function appendResource(
  view: ConversationView | null,
  event: Extract<
    ConversationEvent,
    { readonly eventType: typeof ConversationEventType.ResourceAssociated }
  >,
): ConversationView | null {
  if (
    view === null ||
    view.resources.some(
      (resource) =>
        resource.resourceId === event.payload.resourceId &&
        resource.threadId === event.payload.threadId,
    )
  )
    return view;
  return {
    ...view,
    resources: [...view.resources, event.payload],
  };
}

function reviseEntry(
  view: ConversationView | null,
  event: Extract<
    ConversationEvent,
    { readonly eventType: typeof ConversationEventType.EntryRevised }
  >,
): ConversationView | null {
  if (view === null) return view;
  return {
    ...view,
    entries: view.entries.map((entry) =>
      entry.entryId !== event.payload.entryId
        ? entry
        : {
            ...entry,
            body: event.payload.body,
            revisions: [
              ...entry.revisions,
              { body: event.payload.body, occurredAt: event.occurredAt },
            ],
          },
    ),
  };
}

function tombstoneEntry(
  view: ConversationView | null,
  event: Extract<
    ConversationEvent,
    { readonly eventType: typeof ConversationEventType.EntryTombstoned }
  >,
): ConversationView | null {
  if (view === null) return view;
  return {
    ...view,
    entries: view.entries.map((entry) =>
      entry.entryId === event.payload.entryId ? { ...entry, deleted: true } : entry,
    ),
  };
}
