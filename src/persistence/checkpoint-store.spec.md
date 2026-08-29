# Checkpoint Store — Component Specification

## Type, purpose, and scope

Adapter. The Checkpoint Store is the durable per-consumer read cursor that
implements Kernel's `CheckpointStore` port. Each checkpoint is a single
integer — how far into the journal, by global position, a named consumer has
read — and the store has no knowledge of what that consumer does with it.

## Responsibilities and boundaries

The Checkpoint Store owns loading, saving, and resetting a consumer's stored
position. It does not decide what a consumer is, when it should advance, or
what "caught up" means for that consumer — those are the calling component's
responsibility.

## Core policies, invariants, and behaviours

- Loading a consumer that has never saved a checkpoint MUST return `0`,
  meaning nothing has been read yet.
- Saving MUST reject an attempt to move a consumer's checkpoint backward: a
  checkpoint's stored value MUST be monotonically non-decreasing over its
  lifetime between resets.
- Resetting a consumer MUST remove its stored checkpoint entirely, returning
  it to the never-saved (`0`) state, without affecting any other consumer's
  checkpoint.
- The filesystem implementation MUST additionally validate, on load, that a
  stored checkpoint belongs to the requested consumer name and holds a
  non-negative safe integer, treating any other stored shape as corrupt
  rather than silently coercing it.
- Filesystem checkpoints use injective v2 UTF-8 base64url paths. When no v2
  checkpoint exists, the store may read the legacy path only when its parsed
  consumer name matches the requested consumer; a foreign legacy collision is
  treated as absent and reset never deletes it. Ill-formed UTF-16 consumer
  identities are rejected before filename encoding.

## Conceptual schema

**Checkpoint**

| Field | Type | Description |
| --- | --- | --- |
| `consumer` | string | The name a checkpoint is stored under; an opaque string as far as the store is concerned. |
| `globalPosition` | non-negative integer | How far into the journal this consumer has read; monotonically non-decreasing until reset. |

## Dependencies and system role

- Kernel — the `CheckpointStore` port.
- Projection Runner (depends on Checkpoint Store) — the sole reader and
  writer in normal operation, advancing a consumer's checkpoint after each
  event it considers and resetting it before a rebuild.

## Decisions, exclusions, and deferred capability

- No support for advancing multiple consumers' checkpoints together as one
  atomic operation; each consumer's checkpoint is independent of every
  other's.
- Legacy checkpoint paths remain for forward migration and best-effort binary
  downgrade replay. A binary downgrade after reset is unsupported because the
  old path may deliberately have been removed.
