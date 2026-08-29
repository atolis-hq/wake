---
asOf: 15f550dbd4142dbcf86aa5409d13d0291fc43fec
---

# Persistence — Module Specification

## Purpose and scope

Persistence gives Kernel's storage ports physical form. It implements the
event journal, projection store, and checkpoint store that every other module
depends on through Kernel, in two parallel forms: a filesystem-backed
implementation for real Wake homes, and an in-memory implementation that is a
permanent test harness expressing the same contract. It also owns the
mechanics that make a shared filesystem safe to treat as the source of
truth — locking and atomic writes — and the process that advances registered
projections forward from the journal. Persistence has no knowledge of what an
event means; it stores and replays whatever envelopes and projection
definitions the rest of the system gives it.

## Responsibilities and boundaries

Persistence owns:

- Durable, replayable storage of the event journal — assigning each accepted
  event its position within its own stream and within the journal as a
  whole, and replaying it back in that same order.
- Durable storage of projection values, keyed by namespace and key, each
  stamped with the journal position it reflects.
- Durable storage of per-consumer checkpoints, the read cursors that let a
  projection resume without rescanning the whole journal.
- A general-purpose filesystem lock, and its use to serialize concurrent
  journal writers on a real filesystem. Callers may additionally require a
  stale lock's recorded local PID to be dead before reclaiming it, for a
  long-lived exclusive operational attempt such as self-update.
- Projection subscription helpers that apply a durable handler batch and a
  rebuilder that clears, resets, replays, and checkpoints one projection.
- Supervised durable subscriptions that replay bounded journal batches for
  independently named consumers, advance checkpoints only after a successful
  handler, and report volatile per-consumer health.
- Keyed run serialisation for a consumer's full checkpoint-load, handle, and
  checkpoint-save interval. The filesystem implementation holds a
  consumer-specific lock across that interval.
- Projection rebuilds take that same consumer lock before clearing their
  namespace and retain it through reset, bounded replay, projection writes,
  and checkpoint saves, so a live pass cannot interleave with a rebuild of
  the same projection.
- Versioned, injectively encoded filesystem checkpoint paths, with a
  read-compatible legacy fallback so changing the path scheme does not discard
  existing projection checkpoints.
- Basic operational diagnostics: confirming the journal, projections, and
  checkpoints are reachable.

Persistence does not own:

- What an event type means, what shape its payload takes, or which
  projections exist. Domain modules define events and projection
  definitions; persistence treats both as opaque data it is handed.
- Deciding when a projection run happens, in what order relative to other
  tick work, or how a folded value is used. That is Bootstrap's and the
  owning module's responsibility.
- Selecting which concrete implementation — filesystem or in-memory — is
  wired into a running system. Bootstrap composes the choice.

## Ubiquitous language

- **Stream** — an identity-bearing sequence of events, identified by an
  `(kind, id)` pair; the journal sequences events within a stream and
  compares stream identity by value equality only.
- **Event draft** — a caller-constructed candidate event, complete except for
  the fields only the journal can assign.
- **Event envelope** — a draft plus the fields the journal assigns at the
  moment it durably accepts the draft: when it was recorded, its position
  within its stream, and its position within the whole journal.
- **Global position** — a journal-wide, strictly increasing integer assigned
  once, at append time, to every accepted event; it defines the one true
  replay order across every stream.
- **Sequence** — a per-stream, strictly increasing integer, starting at 1,
  giving an event's position within its own stream.
- **Namespace** — a projection's own partition of the projection store,
  conventionally named after the projection definition.
- **Consumer** — the name a checkpoint is stored under; a registered
  projection's consumer name is derived from its own definition name.
- **Registered projection** — a projection definition (name, event selector,
  initial value, and fold function) that the projection-advancing process
  knows to run; the definition itself is owned by a domain module.

## Core policies, invariants, and behaviours

- Persistence MUST provide behaviourally equivalent filesystem and in-memory
  implementations of each Kernel storage port. The two implementations MAY
  differ only in mechanics that have no meaning without a real filesystem —
  locking, atomic rename — never in the outcome a caller observes.
- A stored projection value MUST be treated as fully rebuildable: discarding
  it and replaying the journal from the beginning MUST reproduce an
  identical value. Persistence MUST NOT treat a projection value as a fact
  the journal itself needs to agree with; the journal is authoritative.
- Persistence MUST NOT decode or interpret event payloads. It validates only
  the Kernel envelope shape common to every event — the fields every event
  carries regardless of domain — never a domain-specific field.
- Global position MUST be assigned exactly once, at the moment an event is
  durably accepted, and MUST be strictly increasing across the entire
  journal. It MUST NOT be reassigned, renumbered, or reinterpreted by a
  later read or rebuild.
- Every storage port's write operations MUST be safe to retry: replaying an
  already-applied write MUST leave stored state unchanged rather than
  duplicating or corrupting it. Each component page states its own exact
  idempotency rule.

## Conceptual schema

**Event envelope**

| Field | Type | Description |
| --- | --- | --- |
| `eventId` | identity | Caller-assigned identity for the draft; the basis for idempotent append. |
| `eventType` | string | Domain-defined event type name; opaque to persistence. |
| `schemaVersion` | integer literal `1` | Kernel envelope schema version; validated, not interpreted. |
| `occurredAt` | offset ISO timestamp | Caller-supplied business time the event represents; persistence never sets or alters it. |
| `correlationId` / `causationId` | identity | Kernel tracing identifiers; opaque to persistence. |
| `actor` / `source` | Kernel closed vocabulary + identity | Who or what produced the event; opaque to persistence. |
| `stream` | `(kind, id)` pair | The stream this event belongs to; persistence sequences by value equality only, never by parsing `id`. |
| `payload` | opaque | Domain-defined event body; stored and replayed unopened. |
| `recordedAt` | offset ISO timestamp | Set by the journal, from its own clock, at the moment the batch is durably accepted. |
| `sequence` | positive integer | This event's 1-based position within its own stream; assigned once at append. |
| `globalPosition` | positive integer | This event's 1-based position within the whole journal; assigned once at append, strictly increasing, defines replay order. |

**Stored projection**

| Field | Type | Description |
| --- | --- | --- |
| `namespace` | string | Partitions one projection's values from every other projection's. |
| `key` | string | The identity within the namespace this value is keyed by. |
| `lastGlobalPosition` | non-negative integer | The journal position of the last event folded into this value; guards against re-applying an event out of order. |
| `value` | opaque | The domain projection's own folded read-model value; opaque to the store. |

**Checkpoint**

| Field | Type | Description |
| --- | --- | --- |
| `consumer` | string | The name a checkpoint is stored under; an opaque string as far as persistence is concerned. |
| `globalPosition` | non-negative integer | How far into the journal this consumer has read; monotonically non-decreasing until reset. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [Event Journal](event-journal.spec.md) | adapter | Append, per-stream and journal-wide ordering, idempotent replay of event envelopes | The durable record every other component and module ultimately reads from; projection subscription and rebuild source. |
| [Projection Store](projection-store.spec.md) | adapter | Keyed storage of current projection values, stamped with the position they reflect | Written by projection subscriptions and rebuilds; read by every module's query paths and diagnostics. |
| [Checkpoint Store](checkpoint-store.spec.md) | adapter | Per-consumer durable read cursor into the journal | Advanced by the durable host after projection batch handling and reset/saved by rebuilds. |
| [File Lock](file-lock.spec.md) | adapter | Mutual exclusion over a filesystem path, with optional PID-liveness-protected stale reclamation | Used by the filesystem Event Journal to serialize concurrent writers and by Bootstrap safe self-update for exclusive full attempts; exported for reuse. |
| [Projection Subscription and Rebuilder](projection-runner.spec.md) | policy/process | Applying durable projection batches and rebuilding one projection under the same consumer lock | The durable host supplies batches and checkpoints them after handling; the rebuilder holds the same lock across clear/reset/replay. |
| [Durable Subscription Host](durable-subscription-host.spec.md) | policy/process | Independent checkpointed consumer loops, retry, health, cancellation, and keyed serialisation | Tails the journal for named consumers without interpreting their events. |

## Dependencies and system role

- Kernel — the storage port interfaces (event journal, projection store,
  checkpoint store, projection definition), the event draft/envelope
  shapes, envelope decoding, and identifier conventions. Persistence exists
  to implement Kernel's ports; it has no other dependency.
- Bootstrap (depends on Persistence) — selects the filesystem
  implementations for a real Wake home, wires them into the composition
  root, and currently schedules the legacy Projection Runner path. Migrating
  Bootstrap to projection subscriptions is separate work.
- Every domain module (depends on Persistence indirectly, through Kernel's
  ports) — appends to and reads from the journal, and supplies the
  projection definitions the Projection Runner advances. Persistence never
  depends back on a domain module.

## Decisions, exclusions, and deferred capability

- Persistence currently takes no operator configuration: filesystem roots
  are supplied directly by Bootstrap's own path resolution, lock staleness
  and projection batch-size are fixed code defaults, and no `persistence`
  configuration surface is exposed yet, despite the module owning that
  configuration namespace for future use.
- There is no compaction, archival, or deletion of journal history; the
  journal grows without bound and a rebuild always replays it in full.
- There is no blocking or automatic retry around lock contention; a caller
  that loses the race to acquire a lock receives an immediate failure and
  must decide whether and when to retry.
- Corrupt on-disk state — a malformed envelope, an out-of-order global
  position — is surfaced as a thrown error at read time; persistence
  attempts no automatic repair.
