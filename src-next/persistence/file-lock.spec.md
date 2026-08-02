# File Lock — Component Specification

## Type, purpose, and scope

Adapter. File Lock is a general-purpose, filesystem-based mutual-exclusion
primitive: it serializes access to a shared resource identified by a
filesystem path, across process boundaries. It is used internally to
serialize the filesystem Event Journal's writers, and is exported as part of
Persistence's public contract for reuse by anything else needing the same
primitive. It has no in-memory counterpart — mutual exclusion within a
single process needs no filesystem lock.

## Responsibilities and boundaries

File Lock owns acquiring, releasing, and reclaiming a stale exclusive lock
at a given path. It does not own what the locked operation does, does not
queue or order waiting acquirers, and does not coordinate anything beyond
the single lock path it is given.

## Core policies, invariants, and behaviours

- Acquiring a lock MUST be a single, non-blocking attempt: it MUST either
  succeed or fail immediately, never wait or retry internally.
- A lock is held by writing lock-metadata to the path using exclusive
  creation; an acquisition attempt against an existing, non-stale lock file
  MUST fail.
- An acquirer MAY supply a staleness threshold. A lock whose own recorded
  acquisition time is older than that threshold MUST be treated as
  abandoned and reclaimed automatically on the next attempt, without
  requiring its original holder to release it.
- Releasing a lock MUST remove the lock file only if it still holds the
  same lock identity that was acquired; it MUST NOT remove a lock file that
  has since been reclaimed by a different holder. Release MUST be
  best-effort: a lock file that is already gone MUST NOT cause an error.
- The bounded helper that acquires a lock, runs an operation, and releases
  it afterward MUST raise an error immediately if the lock could not be
  acquired, without running the operation, and MUST always release an
  acquired lock once the operation finishes, whether it succeeded or threw.

## Conceptual schema

**Lock metadata**

| Field | Type | Description |
| --- | --- | --- |
| `pid` | integer | The acquiring process's own OS process id; informational only. |
| `acquiredAt` | offset ISO timestamp | When this lock was written; the basis for staleness comparison. |
| `lockId` | identity | A per-acquisition random identity distinguishing this holder from any later reclaimer of the same path. |

## Dependencies and system role

- Node's filesystem primitives — File Lock's own storage mechanism; it has
  no dependency on Kernel or any other Wake module.
- Event Journal (depends on File Lock, filesystem implementation only) —
  serializes its append path through this primitive.

## Decisions, exclusions, and deferred capability

- No cross-platform advisory-lock integration (such as `flock`/`fcntl`);
  the primitive relies entirely on atomic exclusive file creation.
- No queueing or fairness among concurrent acquirers; a caller that loses
  the race is responsible for its own retry policy.
