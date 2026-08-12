# Signal policy — Component Specification

## Type, purpose, and scope

Policy/process. This component owns three related decisions: redeclaring an
explicit Signal wait on an instance that is already waiting or blocked,
accepting an external Signal against a current wait (including approval
authority), and recording an Activity's own mid-execution `waiting` outcome
as a wait.

## Ubiquitous language

- **Explicit wait redeclaration** — the `waitForSignal` decision: changing
  the Signal expectation of an instance that is already `waiting` or
  `blocked`. It is distinct from the primary way an instance becomes
  `waiting` in the first place, which is the activation and transition
  policy resolving a route's `await` or an implicit-wait target.

## Responsibilities and boundaries

Signal policy owns matching an incoming `OrchestrationSignal` against the
instance's current wait expectation, judging whether the signal's decision
evidence and approval authority are acceptable, and folding an Activity's
own `waiting` outcome into the same `waitingFor` shape used by an explicit
route wait. It does not decide *that* an instance should start waiting as
part of a Stage transition — that is the activation and transition policy's
`resumeToTarget`/`finishRoute`, which this component's `acceptSignal` reuses
once a wait is satisfied. It does not resolve who is *asking* to satisfy a
wait from outside Orchestration; a caller supplies the `OrchestrationSignal`
and, for `auto` authority, the WorkItem's consent fact.

## Core policies, invariants, and behaviours

**Explicit wait redeclaration (`waitForSignal`)**

- MUST only be accepted when the instance's current status is `waiting` or
  `blocked`; an instance that is `active` or `completed` MUST be rejected —
  this decision changes an existing wait, it does not start one.
- The declared signal kind MUST NOT be empty.
- Acceptance appends `SignalWaitStarted` with the given expectation as-is,
  including its optional `from` authority restriction.

**Accepting a Signal (`acceptSignal`)**

- A signal whose `providerEventId` already appears in `acceptedSignalIds`
  MUST be ignored as a duplicate ("provider signal was already accepted");
  redelivery is safe and non-erroring.
- Acceptance MUST be ignored when the instance is not currently `waiting` or
  has no `waitingFor` expectation at all.
- Acceptance MUST be ignored unless the signal's `kind`, `resourceId`, and
  `revision` all match the current expectation exactly.
- Acceptance MUST be ignored when the signal lacks decision evidence: a
  non-empty `actorId`, `actorDecision.authorized === true`, and a non-empty
  `actorDecision.evidenceId` are all required.
- Acceptance MUST be ignored when `providerEventId` is empty.
- When the current expectation declares a `from` authority list, the
  signal's authority (defaulting to `human` when the signal carries none)
  MUST be one of the declared entries or acceptance is ignored; when the
  expectation declares no `from` at all, any authority is accepted. A
  Signal resuming an Activity's own `waiting` outcome never carries a `from`
  restriction, since that wait is recorded by this component with no
  authority list at all (see below) — any authority satisfies it.
- Authority acceptance is per-kind: `human` is accepted if any declared
  entry is `human`; `auto` is accepted only if the declared list contains
  `auto` **and** the caller-supplied consent is `true`; `watch` is accepted
  only if a declared `watch` entry's id equals the signal authority's watch
  id.
- When the current expectation declares an `onRejectResume` target (a Watch
  gate's wait), the signal's `outcome` — if present — MUST be `done` or
  `rejected`; a `blocked` or `failed` outcome MUST be ignored ("watch-gate
  signal outcome is neither done nor rejected"). An expectation with no
  `onRejectResume` places no constraint on `outcome`.
- **Auto-approval consent is read from Work, not carried on the Signal
  itself.** The application command that invokes `acceptSignal`
  (`AcceptSignal.execute`) loads the instance's WorkItem via `WorkService`
  and passes `item?.autoApprovalGranted ?? false` as the domain function's
  `consent` input; a WorkItem that does not exist or does not currently
  carry that grant is treated as no consent. This is the exact mechanism
  the module specification's approval-authority language refers to; the
  domain decision itself never queries Work directly.
- On acceptance: `SignalAccepted` (carrying the resolved authority) is
  appended first. When the signal's `outcome` is `rejected`, an explicit
  `onRejectResume` target wins and the shared transition resolution reaches
  it. Without `onRejectResume`, rejection re-requests the current Stage's
  configured Activity and MUST NOT use the success `resume` target. For any
  other accepted outcome, if the expectation declares a `resume` target, the
  shared transition resolution reaches that target next. If it declares no
  `resume` target — the case for a wait recorded from an Activity's own
  `waiting` outcome — the current Stage's own configured Activity is
  requested again, resuming the interrupted Activation rather than
  transitioning anywhere.

**Recording an Activity's own wait (`acceptWaitingOutcome`)**

- Applies only when the accepted outcome's kind is `waiting`; any other kind
  is out of this component's scope.
- A `waiting` outcome whose data is already reflected by the pending
  Activation's own `waiting` status, matching `intentEventId` and
  `signalKind`, MUST be treated as already recorded and ignored — redelivery
  of the same self-reported wait is a no-op.
- Acceptance appends `ActivityWaiting`, not `SignalWaitStarted`: an
  Activity's own mid-execution pause is a distinct event from a
  Stage-level `await` gate, even though both are folded into the same
  `waitingFor` shape by the WorkflowInstance aggregate. The recorded
  expectation carries only `signalKind` and `intentEventId` — no `from`
  authority list — which is why the corresponding `acceptSignal` accepts any
  authority for this kind of wait.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `orchestration.signal-wait-started` | An explicit `waitForSignal` redeclaration is accepted | The instance is now waiting for the newly stated Signal expectation. |
| `orchestration.signal-accepted` | An external Signal matches the current wait and passes authority | The wait is now satisfied by this specific provider event. |
| `orchestration.activity-waiting` | The pending Activation itself reports a `waiting` outcome | The Activation is paused mid-execution on a named Signal, not completed. |

## Conceptual schema

**OrchestrationSignal** — the typed input to `acceptSignal`; not itself
persisted independently of the `SignalAccepted` fact it produces.

| Field | Type | Description |
| --- | --- | --- |
| `kind` | Signal kind | Must equal the current wait's `signalKind` to match. |
| `resourceId` | optional string | Must equal the current wait's `resourceId`, if either declares one. |
| `revision` | optional string | Must equal the current wait's `revision`, if either declares one. |
| `actorId` | string | The actor the provider attributes this signal to; must be non-empty. |
| `actorDecision` | `{ authorized, evidenceId }` | Decision evidence; both fields required for acceptance. |
| `providerEventId` | provider event identity | Deduplication key; guards against re-accepting the same signal. |
| `authority` | optional ApprovalAuthority | The authority making this signal; defaults to `human` when absent. |
| `outcome` | optional closed vocabulary: `done` / `rejected` / `blocked` / `failed` | The Activity-outcome-shaped verdict this signal carries, e.g. a Watch gate's approve/reject decision; constrained to `done`/`rejected` when the current wait declares `onRejectResume`. |

## Dependencies and system role

- Work (depended on by the application command, not this domain function
  directly) — supplies `autoApprovalGranted`, the sole source of `auto`
  authority consent.
- Activation and transition policy — supplies the shared transition
  resolution this component calls once a wait's `resume` target is reached,
  and is itself the source of most `SignalWaitStarted` facts (via a route's
  `await` or an implicit-wait target), which this component's `acceptSignal`
  then satisfies.
- Child workflow policy (depends on this component) — a child's completion
  is reconciled to its parent by constructing a signal and passing it
  through this same `acceptSignal` decision, so a completed child is
  accepted exactly like any other external Signal.
- Kernel — event/actor/source conventions for the facts this component
  drafts.

## Decisions, exclusions, and deferred capability

- There is no timeout or expiry on a wait; an instance remains `waiting`
  indefinitely until a matching Signal is accepted or the instance is
  explicitly blocked.
- Authority is only ever widened by the WorkItem's live `autoApprovalGranted`
  value at the moment `acceptSignal` runs; consent is not itself a durable
  fact this component records, and revoking it has no effect on a wait
  already satisfied.
