import type { ConversationEvent, ConversationEventData } from '../contracts/events.js';
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
  const data = event.event;
  switch (data.eventType) {
    case ConversationEventType.Created:
      return {
        conversationId: event.stream.id,
        workItemId: data.payload.workItemId,
        entries: [],
        resources: [],
      };
    case ConversationEventType.EntryRecorded:
      return appendEntry(view, data);
    case ConversationEventType.ResourceAssociated:
      return appendResource(view, data);
    case ConversationEventType.EntryRevised:
      return reviseEntry(view, data);
    case ConversationEventType.EntryTombstoned:
      return tombstoneEntry(view, data);
    case ConversationEventType.EntryRepresentationRecorded:
      return recordRepresentation(view, data);
  }
}

function appendEntry(
  view: ConversationView | null,
  event: Extract<
    ConversationEventData,
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
        representations: [],
      },
    ],
  };
}

function recordRepresentation(
  view: ConversationView | null,
  event: Extract<
    ConversationEventData,
    { readonly eventType: typeof ConversationEventType.EntryRepresentationRecorded }
  >,
): ConversationView | null {
  if (view === null) return view;
  return {
    ...view,
    entries: view.entries.map((entry) =>
      entry.entryId !== event.payload.entryId ||
      entry.representations.some(
        (representation) =>
          representation.resourceId === event.payload.resourceId &&
          representation.externalId === event.payload.externalId,
      )
        ? entry
        : {
            ...entry,
            representations: [
              ...entry.representations,
              { resourceId: event.payload.resourceId, externalId: event.payload.externalId },
            ],
          },
    ),
  };
}

function appendResource(
  view: ConversationView | null,
  event: Extract<
    ConversationEventData,
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
    ConversationEventData,
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
    ConversationEventData,
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
