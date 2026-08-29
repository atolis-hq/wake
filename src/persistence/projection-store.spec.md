# Projection Store — Component Specification

## Type, purpose, and scope

Adapter. The Projection Store is the keyed storage of current projection
values that implements Kernel's `ProjectionStore` port. It holds exactly one
current value per `(namespace, key)` pair, each stamped with the journal
position it reflects, and has no knowledge of how that value was derived.

## Responsibilities and boundaries

The Projection Store owns storing, reading, listing, and clearing values by
`(namespace, key)`. It does not decide when or how a value changes — that
fold is supplied by a projection definition and driven by the Projection
Runner — and it performs no partial merge: every write replaces the entire
stored value for its key.

## Core policies, invariants, and behaviours

- A write MUST replace the entire stored value for a `(namespace, key)`
  pair; the store MUST NOT merge or diff against the previous value.
- A write MUST be atomic from a reader's perspective: a concurrent read
  MUST observe either the fully previous value or the fully new one, never
  a partial write.
- Reading a `(namespace, key)` that has never been written MUST return
  `null` rather than throwing or fabricating a default value.
- `clear` MUST remove every stored value in the given namespace, or every
  stored value across all namespaces when none is given.
- `list` MUST return every stored value currently held in the given
  namespace, and MUST return an empty result for a namespace that has never
  been written to, rather than an error.
- The filesystem implementation MUST reject a namespace or key containing a
  path separator, since both are encoded directly into the storage path;
  this restriction is specific to the filesystem implementation and is not
  part of the port's own contract.
- The filesystem implementation's storage-name encoding MUST NOT produce a
  `%` character in the resulting path segment, so two distinct namespace or
  key strings can never collide onto the same stored file.

## Conceptual schema

**Stored projection**

| Field | Type | Description |
| --- | --- | --- |
| `namespace` | string | Partitions one projection's values from every other projection's. |
| `key` | string | The identity within the namespace this value is keyed by. |
| `lastGlobalPosition` | non-negative integer | The journal position of the last event folded into this value; guards against re-applying an event out of order. |
| `value` | opaque | The domain projection's own folded read-model value; opaque to the store. |

## Dependencies and system role

- Kernel — the `ProjectionStore` port and the stored-projection shape.
- Projection subscriptions and rebuilds (depend on Projection Store) — the
  writers in normal operation, applying a projection definition's fold and
  stamping `lastGlobalPosition`.
- Every module's query paths (depend on Projection Store) — read current
  projection values directly, rather than folding events themselves.

## Decisions, exclusions, and deferred capability

- No secondary indexing, filtering, or pagination beyond listing every
  value in a namespace; a caller needing a subset filters client-side.
- No historical or versioned values; only the current value per key is
  retained. The event journal, not the projection store, is the historical
  record.
