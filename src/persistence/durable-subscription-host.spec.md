# Durable Subscription Host — Component Specification

## Type, purpose, and scope

Policy/process. The Durable Subscription Host tails the Event Journal for
many independently named consumers. It supplies bounded event batches to an
opaque handler and advances that consumer's Checkpoint Store cursor only after
the handler succeeds.

## Responsibilities and boundaries

The host owns journal tailing, durable checkpoint advancement, retries,
volatile health, cancellation, and keyed execution serialisation. It does not
interpret event types, decide a handler's business reaction, or make a
handler's effects idempotent.

## Core policies, invariants, and behaviours

- A subscription's consumer name is stable and identifies both its checkpoint
  and its serialisation key. A host invocation rejects duplicate consumer
  names. The host is infrastructure-neutral and requires its caller to supply
  a serialiser explicitly; it never creates an unsafe per-host default.
- `runOnce(subscription, signal?)` validates one subscription, acquires the
  same consumer serialiser used by the resident loop, and executes exactly one
  bounded pass. It returns `{ checkpoint, eventCount }`, reporting the loaded
  checkpoint and zero events when caught up. A provided abort signal is used
  while waiting for the serialiser; the resident loop reuses this same
  primitive for each pass.
- `runThrough(subscription, targetGlobalPosition, signal?)` is the one-shot
  barrier primitive. It acquires that same consumer serialiser once, reloads
  the checkpoint inside the lock, and drains bounded batches only through the
  supplied observed journal position. Events appended after the target remain
  for a later pass; a short non-empty batch never ends the barrier early.
- Batch size is a positive safe integer no greater than 10,000. Fallback wait
  duration is a positive safe integer; invalid values are rejected before any
  consumer loop starts. The default retry policy has a nonzero bounded delay;
  a supplied retry policy must be a function.
- Each pass loads the current checkpoint, reads no more than the requested
  batch size, calls the handler in journal order, then saves the final event's
  global position. A failed handler or checkpoint save leaves the batch
  replayable, providing at-least-once delivery.
- Consumer handlers MUST use stable event identities or idempotent application
  commands, because a process can fail after a successful effect but before
  its checkpoint is durable.
- A failed consumer becomes degraded, waits with bounded exponential backoff,
  and retries independently. Its health and error details are process-local
  observations, never durable facts.
- Consumers wait through the journal's position-aware advisory wake contract
  only while caught up. A notification is an accelerator; the durable
  checkpoint and journal position remain authoritative.
- The in-memory serialiser queues only equal consumer keys. The filesystem
  serialiser holds a base64url-encoded `subscription-<encoded-consumer>.lock`
  across a complete load, handler, and checkpoint-save interval, while
  different consumers may proceed concurrently. This encoding is injective,
  including for names that collide under the legacy checkpoint encoder.
- Aborting a host run stops every owned consumer and resolves its completion
  after each loop has stopped.

## Dependencies and system role

- Kernel — Event Journal, Checkpoint Store, and Event Envelope contracts.
- File Lock — the filesystem serialiser's cross-host mutual exclusion.
- Bootstrap — will compose concrete consumers and expose their volatile
  health; it does not supply durable subscription state.

## Decisions, exclusions, and deferred capability

- The host has no domain event allowlist, partitioning policy, or durable
  failure ledger. Consumers select and react to events themselves.
- Backoff, health, and journal notifications are deliberately volatile. Only
  the journal and checkpoints survive restart.
- File checkpoints use v2 injective UTF-8 base64url paths. When no v2 file
  exists, FileCheckpointStore reads its legacy encoded path; later saves write
  v2 while retaining the legacy file for forward migration and best-effort
  downgrade replay. A legacy collision whose stored consumer does not match
  is treated as absent and is never deleted by that foreign consumer's reset.
  Binary downgrade after reset is unsupported. Checkpoint-path migration is
  independent of runtime architecture, and a binary rollback does not discard
  durable facts.
