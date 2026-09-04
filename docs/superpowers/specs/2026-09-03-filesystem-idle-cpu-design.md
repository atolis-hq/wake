# Filesystem Idle CPU Fix

## Outcome

Reduce Wake's recurring idle CPU and container restart cost without changing
subscription semantics, scheduler timing, journal authority, or persistence
technology.

## Evidence

The deployed runtime has 25 processors at journal head. On each fallback cycle,
those processors repeatedly validate the same JSONL segment fingerprints. Live
sampling correlated the CPU bursts with processor and activation-scheduler locks,
while a Node CPU profile showed the JavaScript thread idle and filesystem workers
active. Container restart also recursively changes ownership across `.wake/` before
starting Wake.

## Change

`FileEventJournal` will share one in-flight segment-fingerprint read between
concurrent callers. A validated fingerprint result will be reused for at most 30
seconds by the many related reads in one reconciliation pass. Local appends and filesystem
watch notifications invalidate it immediately; a bounded expiry preserves the
existing fallback detection of a missed external notification. A failed refresh is
not cached.

The sandbox entrypoint will create `.wake/` with the required ownership when it is
new, but will not recursively `chown` an existing tree on every start. Existing
operator-created trees with unsuitable ownership remain an explicit setup or
migration concern rather than an unbounded startup operation.

## Compatibility and failure handling

- JSONL remains authoritative and its persisted representation is unchanged.
- No event, projection, checkpoint, or configuration migration is required.
- Logical subscriptions, processor checkpoints, and the 30-second scheduler
  fallback retain their current behavior.
- A watcher event makes the next read refresh from disk.
- If watcher delivery is missed, expiry forces a filesystem refresh.
- A refresh error is returned to callers and a later call may retry.

## Verification

Tests will establish that concurrent journal reads share one fingerprint scan,
cached validation is invalidated by watcher notification, expiry detects an
external change, and refresh failure is recoverable. Sandbox-generation tests will
establish that startup no longer contains recursive ownership mutation while still
creating the required writable directory.

## Deferred improvements

This change does not introduce SQLite, retention or compaction, a shared physical
event tailer, deadline-indexed scheduling, or scheduler-pipeline decomposition.
Those remain separate architectural improvements after this PR is merged.
