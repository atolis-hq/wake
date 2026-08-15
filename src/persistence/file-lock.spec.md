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
- Without `staleRequiresDeadProcess`, the lock retains the legacy single-file
  representation and time-only recovery behavior. With that option, a lock is
  held by writing an immutable, uniquely named owner record under the path's
  owner-record directory. Another live owner record blocks acquisition.
- The unique record name MUST encode the owner PID and acquisition time so an
  acquirer can evaluate a record left incomplete by a crash. Incomplete
  records remain blocking unless their encoded owner is proven dead and stale.
- While a new owner is active it MUST also hold a legacy-path compatibility
  record dated far enough in the future that an old binary cannot time-reclaim
  it. A new binary correlates that record to its unique owner record. If the
  owner crashes, new binaries can recover under normal stale policy, but the
  compatibility record intentionally leaves old binaries fail-closed until
  operator cleanup. This is the bounded rolling-upgrade contract; rollback
  after such a crash requires removing the abandoned compatibility record.
  A strict acquirer that encounters a non-compatibility legacy lock fails
  closed even if its PID appears dead; operator cleanup is required before
  entering strict mode because old release/delete behavior cannot safely mix
  with immutable owner records.
- An acquirer MAY supply a staleness threshold. A lock whose own recorded
  acquisition time is older than that threshold MUST be treated as
  abandoned and reclaimed automatically on the next attempt, without
  requiring its original holder to release it.
- An acquirer that opts into local-owner liveness MAY require a stale lock
  to be reclaimed only after its recorded PID is proven dead. An indeterminate
  liveness probe (including permission failure) MUST be treated as live, so
  the lock is retained. Callers that do not opt in retain the time-only stale
  reclamation policy above.
- Strict stale recovery MUST NOT delete or replace a shared owner pathname. A
  stale record may be ignored and compacted only when its PID is proven dead.
  Malformed or unreadable records fail closed. Simultaneous strict contenders
  may all lose, but MUST NOT both acquire. Without the opt-in, the legacy
  time-only policy and representation remain unchanged.
- The bounded helper's default stale threshold still requires its recorded
  owner's local PID to be proven dead before that record is ignored.
- Proven-dead unique records are compacted during acquisition. A directory
  above 1,024 records fails closed so acquisition work stays bounded; PID reuse
  may temporarily retain a dead record as a safe false positive.
- Strict release MUST remove only its own unique owner record. It MUST NOT
  wait on another contender or remove another owner's record. The last current
  owner removes the compatibility record before its own record; while that
  owner record remains, a concurrent newcomer must withdraw. Release MUST be
  best-effort: a record that is already gone MUST NOT cause an error.
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
