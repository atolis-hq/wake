# Event Journal — Component Specification

## Type, purpose, and scope

Adapter. The Event Journal is the append-only, replayable store of event
envelopes that implements Kernel's `EventJournal` port. It translates
append and read calls against a physical (filesystem) or in-memory store
while enforcing the integrity Kernel itself does not enforce: per-stream
sequencing, journal-wide ordering, and append idempotency.

## Ubiquitous language

- **Append batch** — the set of event drafts passed to one append call;
  accepted or rejected as a whole with respect to stream sequencing, though
  individual drafts within it may already have been recorded by an earlier
  call.
- **Expected sequence** — the caller's belief of how many events already
  exist in the target stream, supplied with every append as an optimistic
  concurrency check.

## Responsibilities and boundaries

The Event Journal owns: assigning `recordedAt`, `sequence`, and
`globalPosition` to each newly accepted draft; enforcing stream-level
optimistic concurrency; enforcing event-id idempotency, both within a batch
and against everything previously recorded; and the one true replay order
across the whole journal.

It does not own: interpreting an event's type or payload; deciding stream
identity — the caller supplies the `(kind, id)` pair; or retrying on its
caller's behalf when a write cannot currently be accepted.

## Core policies, invariants, and behaviours

**Sequencing and ordering**

- `sequence` MUST be strictly increasing within a stream, starting at 1,
  with no gaps, matching the number of events already accepted for that
  stream identity. Two streams MUST be compared by `(kind, id)` value
  equality; the journal MUST NOT parse or interpret `id`.
- `globalPosition` MUST be strictly increasing across the entire journal,
  assigned once per event at the moment it is durably accepted, and MUST
  NOT be reassigned by any later read.
- `recordedAt` MUST be read from the adapter's own clock at the moment the
  batch is durably accepted, never supplied by the caller and never reused
  from a previous call.
- `readAll` MUST return events strictly in increasing `globalPosition`
  order, limited to events whose `globalPosition` is greater than the given
  cursor. `readStream` MUST return only events belonging to the requested
  stream, in `sequence` order.

**Acceptance and idempotency**

- An append MUST be rejected, with a distinguishable error, when the
  supplied expected sequence does not match the target stream's current
  length.
- An append batch containing the same `eventId` twice with different
  content MUST be rejected.
- An append batch every one of whose drafts has already been recorded,
  under the same `eventId` with identical content, MUST be accepted as a
  no-op: it MUST return the previously recorded envelopes and MUST NOT
  perform the expected-sequence check or record anything again. This is
  what makes a batch safe to resubmit after a caller-side failure that left
  the outcome of the first attempt unknown.
- A batch mixing previously recorded drafts with new ones MUST still
  satisfy the expected-sequence check against the stream's current actual
  length, and MUST append only the drafts not already recorded.
- Every draft in one append call MUST target the same stream as the call
  itself; a draft naming a different stream MUST cause the whole append to
  be rejected.

**Corruption**

- A malformed or corrupted stored envelope — invalid encoding, an envelope
  failing Kernel's schema, or an out-of-sequence `globalPosition` — MUST
  cause the read to fail with an error identifying the offending location,
  rather than being silently skipped or truncated.

**Filesystem-specific mechanics**

- The filesystem implementation MUST serialize concurrent append calls
  against the same journal root with an exclusive lock. A caller that
  cannot acquire it MUST receive an immediate failure rather than blocking
  or being retried internally; a lock left behind by a holder that exceeded
  the staleness threshold MUST be reclaimed automatically.
- Stored events MUST be written one JSON object per line, grouped into one
  file per UTC calendar day of `recordedAt`, and MUST only ever be appended
  to — an existing file is never rewritten in place.

**In-memory divergence**

- The in-memory implementation provides the identical append, read, and
  idempotency contract without any on-disk representation or lock. It
  performs no asynchronous work between validating and mutating its state,
  so concurrent calls cannot interleave; it needs no explicit lock to
  serialize writers because nothing yields control mid-append.

## Conceptual schema

**Event envelope**

| Field | Type | Description |
| --- | --- | --- |
| `eventId` | identity | Caller-assigned identity for the draft; the basis for idempotent append. |
| `eventType` | string | Domain-defined event type name; opaque to the journal. |
| `schemaVersion` | integer literal `1` | Kernel envelope schema version; validated, not interpreted. |
| `occurredAt` | offset ISO timestamp | Caller-supplied business time the event represents; the journal never sets or alters it. |
| `correlationId` / `causationId` | identity | Kernel tracing identifiers; opaque to the journal. |
| `actor` / `source` | Kernel closed vocabulary + identity | Who or what produced the event; opaque to the journal. |
| `stream` | `(kind, id)` pair | The stream this event belongs to; compared by value equality only, never by parsing `id`. |
| `payload` | opaque | Domain-defined event body; stored and replayed unopened. |
| `recordedAt` | offset ISO timestamp | Set by the journal, from its own clock, at the moment the batch is durably accepted. |
| `sequence` | positive integer | This event's 1-based position within its own stream; assigned once at append. |
| `globalPosition` | positive integer | This event's 1-based position within the whole journal; assigned once at append, strictly increasing, defines replay order. |

## Dependencies and system role

- Kernel — the `EventJournal` port, the event draft/envelope shapes,
  envelope schema decoding, and the stream-identity convention; the Event
  Journal exists to implement this port.
- File Lock (depended on by the filesystem implementation only) —
  serializes concurrent writers to the same journal root.
- Projection Runner (depends on Event Journal) — the primary reader,
  advancing every registered projection from `readAll`.
- Every domain module (depends on Event Journal, through Kernel's port) —
  appends its own stream's events and reads them back; the Event Journal
  never depends back on a domain module.

## Decisions, exclusions, and deferred capability

- No compaction, archival, or deletion of past events; the journal grows
  without bound and a full replay always covers its entire history.
- No blocking or automatic retry when a lock cannot be acquired; a caller
  that loses the race must decide for itself whether and when to retry.
- The filesystem implementation assumes at most one Wake process actively
  writes to a given journal root at a time; the stale-lock reclaim exists
  as crash recovery for an abandoned prior holder, not as a mechanism for
  coordinating multiple simultaneously active writers.
