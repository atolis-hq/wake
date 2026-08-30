# Activation claim — Component Specification

## Type, purpose, and scope

Aggregate. Activation claim is the stream-owning aggregate for the
single-flight guard on one Activation: it records which Run currently holds
the right to attempt that Activation, closing the race window between two
callers requesting an attempt for the same Activation before either has a
Run of its own recorded yet.

## Responsibilities and boundaries

Activation claim owns the `ActivationClaimed` and `ActivationReleased` facts
on the activation-claim stream keyed by `ActivationId`, and the check of
whether the stream's most recent claim is still unexpired. It does not
decide whether a new attempt is warranted — the Execution service only
reaches this component after it has already established, from the Run
projection, that no `starting`, `started`, `succeeded`, or `ambiguous` Run exists for
the Activation. It does not itself track or renew a claim's expiry once
recorded; expiry is fixed at claim time.

## Core policies, invariants, and behaviours

- Claiming MUST read the activation-claim stream and inspect only its most
  recent event. If that event is `ActivationClaimed` and its `expiresAt` has
  not yet passed, claiming MUST fail with an error rather than append a
  second concurrent claim.
- Claiming MUST succeed when the stream is empty, when its most recent event
  is `ActivationReleased`, or when its most recent event is an
  `ActivationClaimed` whose `expiresAt` has already passed — an expired
  claim never blocks a new one, regardless of whether the Run that held it
  ever released it.
- A successful claim MUST append `ActivationClaimed` at the stream's current
  length, carrying the claiming `RunId`, the owner, and an `expiresAt` set to
  the claim time plus the configured lease duration (60 seconds when the
  operator has not configured one). This expiry is set once and is never
  extended; it is not renewed the way a Run's own lease is.
- A true concurrent race between two callers both reading the same
  unclaimed stream state MUST resolve to exactly one winner: both attempt to
  append at the same expected sequence, and the journal's optimistic
  concurrency check rejects whichever append does not land first, leaving
  the loser's caller to report a claim failure.
- Releasing MUST append `ActivationReleased` at the stream's current length
  for the given `RunId`. Release does not read or compare against the
  stream's current claim before appending: it does not verify that the
  releasing `RunId` is the one currently claiming the Activation, and always
  succeeds as long as the stream itself is reachable.

## Event catalogue

| Event | Recorded when | Meaning |
| --- | --- | --- |
| `execution.activation-claimed` | This aggregate accepts a claim | The named `RunId` now holds the single-flight right to attempt this Activation until `expiresAt`. |
| `execution.activation-released` | This aggregate accepts a release | The Activation is free for a future claim to succeed again. |

## Conceptual schema

**Activation claim state** (derived from the stream's most recent event, not
a full fold)

| Field | Type | Description |
| --- | --- | --- |
| `activationId` | Activation identity (owned by Activities) | The stream's own identity. |
| `runId` | Run identity | The Run that most recently claimed this Activation; present only while the last event is `ActivationClaimed`. |
| `owner` | string | The owner recorded on the most recent claim. |
| `expiresAt` | timestamp | When the most recent claim stops blocking a new one. |

## Dependencies and system role

- Kernel — event envelope conventions and the optimistic-concurrency check
  on `journal.append` that resolves a true claim race to one winner.
- Execution service (depends on) — the only caller: claims immediately
  before minting a new Run and appending `RunPreparationStarted`, and releases
  unconditionally in a `finally` block once that attempt concludes, whatever
  its outcome.
- Recovery (indirectly relied upon) — because a crashed owner never reaches
  the Execution service's release, a stale claim is only ever cleared by its
  own expiry; Recovery moving that owner's active (`starting` or `started`) Run out of its active state is what lets
  the Execution service's existing-Run check reach this component again for
  a fresh attempt.

## Decisions, exclusions, and deferred capability

- There is no compare-and-release: release does not fail or warn if the
  Activation is not currently claimed by the releasing `RunId`, or is not
  claimed at all. A stale, late release from a Run that lost a claim race
  would still be accepted.
- The claim's expiry is independent of, and generally shorter-lived than,
  the attempt it protects (a long agent Run keeps its own lease renewed for
  the whole attempt, but its activation claim is set once and left to
  expire). This is inconsequential in practice because the Execution
  service's existing-Run check intercepts any further `attempt` call for an
  Activation that still has an active (`starting` or `started`) Run, so this component is not
  consulted again until that Run reaches a terminal status.
