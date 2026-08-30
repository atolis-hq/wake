# Run liveness and cancellation — Component Specification

## Type, purpose, and scope

Policy/process. This component keeps a Run's lease current while it is being
actively driven, and carries out the two-step cancellation protocol
(request, then confirm) that stops an active Run — either for a single Run
or cascaded across every active Run of a set of workflow instances. It
appends onto the Run stream but does not itself decide when a Run should
exist; that is the Execution service's and the Run aggregate's concern.

## Ubiquitous language

See the module specification for Lease, Cancellation, and Recovery. This
component additionally treats **confirming** a cancellation as the act that
also finalizes the Run: confirmation and the terminal `cancelled` status are
recorded together, not as separately observable steps.

## Responsibilities and boundaries

This component owns claiming and renewing a Run's `Lease`, and requesting
and confirming a Run's `Cancellation`. It does not own the Run's creation or
success/failure recording (the Run aggregate's terminal-recording rules),
and it does not itself inspect what actually happened to a Run's external
execution — that is Recovery's responsibility, using this component's
lease-renewal event to record a takeover.

## Core policies, invariants, and behaviours

- `starting` and `started` Runs are lease-active. The first lease is appended
  atomically with `RunPreparationStarted`; cancellation writes retry an
  optimistic-concurrency conflict only after a reload proves the stream sequence
  strictly advanced, return when another writer terminalizes the Run, and fail
  rather than spin when no progress occurred.

**Lease claim and renewal**

- Claiming or renewing a lease MUST operate only on a Run whose current
  status is `starting` or `started`; against any other Run, both MUST fail with an error.
- Claiming a lease MUST fail when the Run already has an unexpired lease
  held by a different owner. Claiming MUST succeed — as a fresh claim, not a
  no-op — when the Run has no lease, an expired lease, or an unexpired lease
  already held by the same owner.
- Renewing a lease MUST fail when the calling owner does not already hold
  the Run's current lease, regardless of expiry — renewal is not a way to
  take over a lease, only to extend one already held.
- Renewing a lease MUST fail when called before the configured renewal
  interval has elapsed since the lease was last (re)acquired. When the
  operator has not configured a renewal interval, renewal is due
  immediately, so renewal is never rejected on timing grounds.
- Each successful claim or renewal MUST set both `acquiredAt` (to the
  current time) and `expiresAt` (to the current time plus the configured
  lease duration; 60 seconds when unconfigured) — renewal resets the full
  window rather than extending the previous `expiresAt`.

**Cancellation request and confirmation**

- Requesting cancellation MUST operate only on a `starting` or `started` Run;
  against any other Run it MUST fail with an error.
- Requesting cancellation MUST append a cancellation-requested fact carrying
  the request time and reason, then signal an in-process abort for that
  `RunId` if one is currently tracked. A `RunId` with no tracked in-process
  execution (owned by a different process, or already finished locally) is
  signalled as a silent no-op — the durable request fact is still recorded.
- Requesting cancellation again before confirmation leaves the recorded request
  unchanged and re-signals any locally tracked execution.
- Confirming cancellation MUST operate only on a `starting` or `started` Run
  that already has a recorded cancellation request; confirming with no prior
  request, or against an inactive Run, MUST fail with an error.
- Confirming cancellation MUST append the confirmation fact and the Run's
  terminal `cancelled` fact together as a single atomic append — a Run's
  cancellation is never durably observable as "confirmed but not yet
  terminal."
- Confirming cancellation does not itself wait for, or verify, that the
  underlying external execution has actually stopped; it finalizes the
  Run's durable status independently of whatever the in-process abort
  signal (if any was delivered) eventually does to the real process.

**Cascading cancellation across workflows**

- Cancelling every active Run of a set of workflow instances MUST consider
  every Run in the journal, not just Runs of a single Activation, and MUST
  act only on those currently `starting` or `started` whose `workflowInstanceId`
  is in the given set.
- For each matching Run, the cascade MUST request and then immediately
  confirm cancellation in sequence, for the given reason, and collect the
  confirmed views. A Run whose confirmation fails (for example because a
  concurrent process already finalized it) MUST propagate that failure to
  the caller rather than skip it silently.

## Event catalogue

| Event | Recorded when | Meaning |
| --- | --- | --- |
| `execution.run-lease-claimed` | A fresh claim succeeds | The named owner now holds exclusive responsibility for driving this Run. |
| `execution.run-lease-renewed` | A renewal succeeds, or Recovery re-leases a Run whose external execution is still running | The lease window has moved forward under (possibly new) ownership. |
| `execution.run-cancellation-requested` | A cancellation request is accepted | The Run is marked for cancellation and any tracked in-process execution is signalled to abort. |
| `execution.run-cancellation-confirmed` | Confirmation is accepted | The cancellation now has a confirmation time. |
| `execution.run-cancelled` | Recorded together with confirmation | The Run reaches its terminal `cancelled` status. |

## Conceptual schema

**Lease**

| Field | Type | Description |
| --- | --- | --- |
| `owner` | string | Identity of the process or actor currently responsible for driving the Run. |
| `acquiredAt` | timestamp | When this lease window was (re)acquired; reset on every claim and renewal. |
| `expiresAt` | timestamp | When this lease window stops protecting the Run from a competing claim. |

**Cancellation**

| Field | Type | Description |
| --- | --- | --- |
| `requestedAt` | timestamp | When cancellation was requested; overwritten by a later request before confirmation. |
| `reason` | closed vocabulary: `operator` / `work-cancelled` / `work-closed` / `workflow-superseded` / `timeout` / `shutdown` / `maintenance` | Why cancellation was requested. |
| `confirmedAt` | timestamp, optional | Set once confirmation is recorded; absent while cancellation is only requested. |

`reason` additionally includes the closed value `maintenance`: safe
self-update exhausted its grace drain and requested cancellation before
checkout.

## Dependencies and system role

- Kernel — event envelope conventions and the Run stream's append
  sequence this component reads before appending.
- Run (co-owns the Run stream with) — this component's facts are folded by
  the Run aggregate's own fold; it does not duplicate that logic.
- Execution service (depends on) — exposes `claim`, `renewLease`,
  `requestCancellation`, and `confirmCancellation` on its surface by
  delegating directly to this component, and tracks the in-process
  `AbortController` map this component signals on request.
- Recovery (depends on) — reuses this component's lease-renewal event shape
  to record that a recovering owner has taken over a Run whose external
  execution was found still running.
- Control-plane (depends on, via cascading cancellation) — cascades a Work
  cancellation into every active Run of the affected workflow instances.

- Bootstrap safe self-update (depends on the public Execution service) reads
  active and ambiguous Run views for its bounded drain, requests
  `starting` and `started` maintenance-cancellable Runs with reason `maintenance`, and waits
  for terminal public views before checkout. It does not add another
  cancellation protocol.

## Decisions, exclusions, and deferred capability

- There is no lease "steal": an owner without the current lease cannot
  renew it, and claiming while a different owner's lease is unexpired is
  rejected outright rather than queued or retried.
- Cascading cancellation confirms immediately after requesting, without
  waiting to observe whether the tracked in-process abort (if any) actually
  stopped the external execution — unlike the two independently exposed
  `requestCancellation`/`confirmCancellation` surface calls, which let a
  caller separate the two steps.
