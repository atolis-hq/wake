# Event panel design

## Goal

Make each event in the target web UI behave like the legacy event panel: a
single-row card with its timestamp, complete event name, ID, and an expansion
chevron. Expanding a card reveals the complete event response as readable,
full-width JSON.

## Design

`EventRow` remains the shared renderer for the events page and work-item event
tabs. Its list item becomes a bordered card containing a summary button and,
when expanded, a body below that button. The summary lays out the timestamp,
event type, event ID, and a chevron whose orientation communicates
`aria-expanded`.

The event type is allowed to take the flexible column and is not truncated.
The timestamp and ID retain compact overflow handling. On narrow viewports, the
ID can be hidden while the timestamp, full event type, and chevron remain.

The expanded body serializes the complete `AuditEventResponse` with
`JSON.stringify(record, null, 2)`, rather than serializing only `payload`.
Its JSON area spans the card width and horizontally scrolls long values instead
of clipping them.

## Testing

Add unit coverage for a full event name in the summary, chevron/toggle state,
and full-record JSON after expansion. Retain the existing feed, pagination, and
live-update tests to show the shared event row preserves current behavior.

## Scope

No API changes are required. The direction indicator is an expansion chevron
for now, not an event-direction value.
