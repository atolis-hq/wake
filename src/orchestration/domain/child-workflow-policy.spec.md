# Child workflow policy — Component Specification

## Type, purpose, and scope

Policy/process. This component derives a child WorkflowInstance's
deterministic request identity, drives its budget claim and start, detects
and rejects a causal repeat within an orchestration group, reacts to
configured Watches by requesting children, and reconciles a completed
child's completion back to its parent as a Signal.

## Ubiquitous language

- **Causal repeat** — a Watch trigger recognised, before a child is
  requested, as belonging to a chain that already produced a child in the
  same orchestration group — either the same `triggerId` or, when the
  trigger carries a `causalCycleId`, the same cycle. Recognised repeats are
  rejected rather than started.

## Responsibilities and boundaries

This component owns the deterministic mapping from a parent, Watch, and
trigger to a stable child request identity, the read that recognises a
causal repeat, the two-step budget-claim-then-start sequence for a genuine
new request, and reconciling a completed child's status into a Signal its
parent can accept. It does not own the primary or budget claim ledgers
themselves — those are OrchestrationGroup's; this component only calls into
them and records the child-facing consequences (a `ChildRequested`/
`ChildStarted` pair on success, a `GroupBudgetExhausted` fact on failure). It
does not decide which events match a Watch or scan WorkflowInstances for
matches — that read is supplied by the activation and transition policy's
query surface (`listWatchMatches`); this component only acts on the matches
it is given.

## Core policies, invariants, and behaviours

**Deriving and validating request identity**

- A child request's identity MUST be `<parentWorkflowInstanceId>:watch:<watchId>:trigger:<triggerId>`;
  redelivering the same trigger for the same parent and Watch always derives
  the same identity, making redelivery naturally idempotent.
- A request whose supplied `requestId` does not equal its derived identity
  MUST be rejected.
- If a WorkflowInstance already exists at the derived identity, requesting
  it again MUST be accepted as a no-op returning the existing view; no new
  claim attempt and no new start is made.

**Claiming and starting**

- A genuine new request MUST first attempt the Watch's per-group budget
  claim; a failed claim MUST NOT start the child. Instead, a
  `GroupBudgetExhausted` fact is recorded on the **parent's** stream, keyed
  by the request's own identity so recording it twice for the same request
  is a no-op. The same append MUST then record `InstanceBlocked` on the
  parent: exhausting a Watch's `maxPerGroup` means the parent cannot continue
  the bounded Watch/parent loop automatically. A typed
  `group-budget-exhausted` result is returned to the
  caller — not an error.
- A successful budget claim MUST proceed to start the child with complete
  provenance (parent, Watch, trigger, causal cycle, request identity); the
  child's own identity equals the request identity.

**Rejecting a causal repeat**

- Recognising a causal repeat is a read performed before requesting a
  child, against every known WorkflowInstance in the same orchestration
  group: a repeat is any existing child (a WorkflowInstance with parent
  provenance) in that group whose `requestId` differs from the candidate's
  but whose `triggerId` matches, or whose `causalCycleId` matches when the
  candidate declares one.
- Rejecting a trigger already present in the parent's `causalRejectionIds`
  MUST be a no-op — a given trigger is only ever rejected once.
- Rejecting a genuinely new repeat MUST append, in order,
  `CausalActivationRejected` and `InstanceBlocked` **on the parent's own
  stream** — a rejected causal repeat blocks the parent that would have
  spawned the repeat, not merely the would-be child, which is never
  created.
- The causal-repeat check and the subsequent reject-or-request call are two
  separate steps, not one atomic decision; the request-identity no-op above
  and the derived identity's determinism are what keep a race between the
  two safe in practice.

**Reacting to a Watch match**

- When the triggering event is `orchestration.signal-wait-started`, the
  reactor resolves the owning WorkflowInstance id directly from that
  event's own stream — a state-transition event is always appended on the
  stream of the instance it describes, so no lookup is needed. When the
  triggering event is instead a run-lifecycle fact (e.g.
  `execution.run-succeeded`), the reactor resolves the run's own owning
  WorkflowInstance id, because a run-lifecycle event fires for every run in
  the system, including one belonging to a Watch's own already-started
  child re-running its own Activity on retry. In either case, the reactor
  discards any (parent, Watch) match whose parent is not that resolved
  instance; without this scoping, any currently-eligible parent's declared
  event type would match regardless of which instance actually produced the
  triggering event, spuriously re-triggering the Watch. A triggering event
  that is neither `orchestration.signal-wait-started` nor a run-lifecycle
  fact — including other orchestration-namespace events such as
  `orchestration.child-completed`, which is recorded on a Watch's spawned
  child's own stream but is meant to trigger the parent's Watch — is not
  scoped this way; those events remain intentionally unscoped so that
  cross-instance coordination facts keep working.
- For each (parent, Watch) match returned for a triggering event, the
  child's causal cycle is the triggering event's own `causalCycleId` when
  its payload carries one, or the derived request identity itself
  otherwise — a trigger with no upstream causal chain seeds a fresh cycle
  equal to its own request.
- A match recognised as a causal repeat is rejected (see above) and no
  child request is attempted for it.
- A match not recognised as a repeat MUST result in a child request that
  completes durably — one of an existing view, a newly started child, or a
  `group-budget-exhausted` result; a caller-side port that returns neither
  is treated as a defect, not a normal outcome.

**Reconciling a completed child**

- A child's own `ChildCompleted` fact MUST be recorded on the child's own
  stream at most once, guarded by whether the child's view already reflects
  it (`childCompletionRecorded`).
- A parent MUST NOT reconsume the same child's completion twice: once a
  child's identity appears in the parent's `acceptedChildCompletionIds`,
  reconciliation for that child is a no-op.
- Reconciling an unconsumed completion constructs a Signal whose `kind`
  equals the `orchestration.child-completed` event type itself, whose
  `providerEventId` is the child's own WorkflowInstance id, and whose
  decision evidence is synthesized internally (actor `orchestration`,
  always authorized) — this Signal is passed through the same Signal
  acceptance decision used for any external Signal.
- If the parent's Signal acceptance ignores this constructed Signal (most
  commonly: the parent is not currently `waiting` for that signal kind), no
  fact is recorded for this attempt at all, including no
  `ChildCompletionConsumed`; the completion is not durably marked consumed
  until the parent is actually waiting for it. Reconciliation is
  re-attempted from scratch every time it runs again.
- On acceptance, the accepted Signal's own events are appended together with
  a `ChildCompletionConsumed` fact, atomically, on the parent's stream.
- Reconciliation across all children is triggered synchronously after every
  accepted Activity outcome, system-wide, not scoped to the specific
  parent/child pair whose outcome was just accepted; there is no
  independent schedule or timer that reconciles a completion outside of
  some instance's outcome being accepted.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `orchestration.child-requested` | A budget claim succeeds for a genuine new request | A child is being started under this parent, Watch, and trigger. |
| `orchestration.child-started` | Immediately following a child request being accepted | The child WorkflowInstance now exists. |
| `orchestration.group-budget-exhausted` | A budget claim fails for a request not already recorded | This trigger did not start a child; the Watch's `maxPerGroup` is already met, and the parent is blocked in the same append. |
| `orchestration.child-completed` | A completed child's own completion is first recorded | This fact now exists on the child's own stream, ready for its parent to consume. |
| `orchestration.child-completion-consumed` | The parent accepts its child's completion as a Signal | The parent has now processed this specific child's completion. |
| `orchestration.causal-activation-rejected` | A Watch trigger is recognised as a causal repeat | This trigger will not start a child; recorded on the parent. |
| `orchestration.instance-blocked` | Immediately following a causal rejection or exhausted Watch budget | The parent cannot proceed automatically. |

## Conceptual schema

**Child coordination metadata** — the shared payload shape carried by every
coordination fact this component produces.

| Field | Type | Description |
| --- | --- | --- |
| `parentWorkflowInstanceId` | WorkflowInstance identity | The requesting parent. |
| `watchId` | Watch identity | The Watch that matched. |
| `triggerId` | string | The triggering event's own identity. |
| `orchestrationGroupId` | Orchestration group identity | Shared with the parent. |
| `causalCycleId` | string | The causal chain this request belongs to. |
| `requestId` | WorkflowInstance identity | The deterministic request/child identity. |
| `childWorkflowInstanceId` | WorkflowInstance identity | The child this metadata concerns; equals `requestId` once started. |

**Group budget exhausted result** — the typed non-error outcome of a failed
budget claim, returned to the caller instead of a started child.

| Field | Type | Description |
| --- | --- | --- |
| `kind` | literal `group-budget-exhausted` | Discriminates this result from a started/existing WorkflowInstanceView. |
| `requestId` | WorkflowInstance identity | The request that could not be admitted. |

## Dependencies and system role

- OrchestrationGroup (depended on) — supplies the per-Watch budget claim
  this component attempts before starting a child; a failed claim is
  translated here into the parent-facing `GroupBudgetExhausted` fact.
- WorkflowInstance (depended on) — actually starts a claimed child, and is
  read to determine an existing child's status for reconciliation.
- Signal policy (depended on) — a completed child's completion is accepted
  through the exact same `acceptSignal` decision used for any external
  Signal.
- Activation and transition policy / its query surface (depended on) —
  supplies the (parent, Watch) matches for a triggering event; this
  component does not itself scan for Watch matches.
- Execution (depended on) — the watch reactor resolves a run-lifecycle
  triggering event's owning WorkflowInstance through Execution's Run
  repository, to scope a Watch match to the run that actually produced the
  event.
- Kernel — event journal and checkpoint conventions for the watch reactor's
  own durable, resumable sweep of the event journal.

## Decisions, exclusions, and deferred capability

- Causal-repeat detection and completion reconciliation both scan every
  known WorkflowInstance rather than reading a per-group or per-parent
  index; there is no dedicated index by orchestration group.
- A budget slot claimed for a request that is later rejected as a causal
  repeat is never released; this matches OrchestrationGroup's own decision
  that a claim is permanent for the life of its group.
- There is no independent schedule that reconciles a completed child's
  Signal on its own; reconciliation only runs as a side effect of some
  instance's Activity outcome being accepted, anywhere in the system.
