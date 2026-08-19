---
asOf: bd8bb1aa03eafa30f725e024ca2d5bf45ad234af
---

# Orchestration — Module Specification

## Purpose and scope

Orchestration interprets configured workflow definitions and runs them as
durable WorkflowInstances. Given a WorkItem and a workflow name, it drives a
sequence of Activity activations through configured stages, arbitrates
retries and repeats, waits for external signals, admits supplemental
commands, and coordinates child WorkflowInstances spawned by Watches. Every
decision is a deterministic function of durable state and typed input; no
step consumes tokens or calls an external system directly.

## Responsibilities and boundaries

Orchestration owns:

- Compiling a configured workflow definition into a validated, immutable
  runtime form, and selecting which configured workflow applies to a
  WorkItem's tags/kind/adapter facts.
- The WorkflowInstance aggregate: its identity, current stage, status,
  pending Activation, wait state, supplemental queue, and coordination
  history.
- Deciding, for a given WorkflowInstance and input (an Activity outcome, a
  signal, a supplemental command request, a child request), which
  Orchestration events to append next.
- Claiming that a WorkItem has exactly one active primary WorkflowInstance,
  and that a Watch's children stay within its configured per-group budget.

Orchestration does not own:

- Invoking an Activity's execution or a Run. It records an Activation
  request; another module executes it and reports the outcome back.
- Preparing a workspace for that execution.
- Polling an external provider for the events that become signals.
- Delivering outbound messages derived from workflow activity.
- Deciding which WorkItems to admit or which lifecycle step a WorkItem is at
  outside its own workflow; deciding *that* a workflow should start for a
  WorkItem, and routing the initial trigger, is a caller's responsibility.
  Orchestration only supplies the pure candidate-to-workflow-name matching
  function that caller uses.

## Ubiquitous language

- **WorkflowDefinition (compiled)** — an operator-configured workflow,
  validated and compiled once into an immutable runtime form: an entry
  Stage, a set of Stages, a set of supplemental Commands, and a set of
  Watches. Compilation is the only place configured strings are turned into
  typed, branded identifiers; nothing downstream re-parses configuration.
- **Stage** — a named step in a WorkflowDefinition that names one Activity to
  activate and, per possible outcome kind, an OutcomeRoute.
- **OutcomeRoute** — the configured consequence of one Activity outcome kind
  at one Stage: a transition target (another Stage, workflow completion, or
  an implicit signal wait), optional repeat/retry bounds, optional follow-on
  Activities to run before transitioning, and an optional explicit Await.
- **WorkflowInstance** — a durable, running instantiation of a
  WorkflowDefinition against one WorkItem: its own identity, current Stage,
  status, and history of Activations, waits, and coordination facts.
- **Activation** — one request to run a named Activity with a given input,
  identified by an ActivationId; a WorkflowInstance has at most one pending
  Activation at a time.
- **Outcome** — the typed result an Activity reports back for an Activation
  (`waiting` / `done` / `rejected` / `blocked` / `failed`), defined by the
  Activities module and consumed here to decide the next OutcomeRoute.
- **Signal** — an external fact (a provider event, an operator decision, a
  child's completion) that a WorkflowInstance is explicitly waiting for,
  matched by kind, and optionally by resource and revision, and optionally
  carrying an approve/reject outcome (e.g. a watch gate's verdict).
- **Wait** — the state of a WorkflowInstance that is paused for a Signal,
  either because an Activity outcome itself reported waiting, or because an
  OutcomeRoute or explicit command declared an Await or a Watch gate.
- **Approval authority** — who may satisfy a Wait's gate: `human`, `auto`
  (only if the WorkItem carries operator auto-approval consent), or a named
  Watch.
- **Watch gate** — a `done` OutcomeRoute's alternative to an explicit Await:
  it starts a wait on the reserved `orchestration.watch-gate-verdict` Signal,
  satisfiable by either the named Watch or a human, then transitions to the
  route's own target on an approving (`done`) verdict or to a configured (or
  same-Stage default) `onReject` target on a rejecting (`rejected`) verdict.
  A route MUST NOT configure both an explicit Await and a Watch gate.
- **Approval-by-default** — a `done` OutcomeRoute with neither an explicit
  Await nor a Watch gate compiles an implicit human-approval Await (the
  `approved` Signal, from `human`); a Stage opts out with
  `requiresApproval: false`.
- **Resource transition** is a `done` OutcomeRoute's configured alternate
  wait resolution, compiled from its `resourceTransitions` entries. A
  transition names a supported external resource-fact event, an optional
  closed predicate, and its own target (or the enclosing route's target).
- **Resource-transition reactor** is the checkpointed application process
  that tails configured evidence triggers. A fact observed while an instance
  waits is offered as live evidence; a `SignalWaitStarted` fact asks evidence
  to recall durable facts that predate the wait. Generic matching only
  determines which Waiting instances declared the event/predicate; an
  injected evidence policy must still authorise the fact and select the
  transition before it can be applied.
- **Supplemental activity** — an Activity requested out-of-band against an
  Active WorkflowInstance by a configured Command, queued and run before the
  WorkflowInstance's own pending Stage activity resumes.
- **Watch** — a configured rule that, while a WorkflowInstance is in a
  matching Stage and status, reacts to a matching event (or a schedule) by
  requesting a child WorkflowInstance.
- **Orchestration group** — the set of WorkflowInstances (one primary, its
  children, their children) that share a `orchestrationGroupId`, and the
  claim ledger that arbitrates primary ownership and per-Watch child budget
  for that group.
- **Primary WorkflowInstance** — the one WorkflowInstance a WorkItem may run
  without parent provenance; claimed once, for the life of the WorkItem.
- **Child WorkflowInstance** — a WorkflowInstance started by a Watch match,
  carrying full provenance back to its parent, Watch, and triggering event.
- **Causal cycle** — a caller-supplied identifier linking a chain of
  Watch-triggered child requests; used to detect and stop a would-be
  infinite trigger loop across an orchestration group.

## Core policies, invariants, and behaviours

- Interpretation MUST be deterministic: the same WorkflowInstance state and
  the same typed input MUST always yield the same decision. No decision
  function reads a clock, a random source, or an external system.
- A WorkItem MUST have at most one active primary WorkflowInstance at a
  time. This is enforced by an idempotent claim, not by inspecting instance
  status; the claim persists for the life of the WorkItem's orchestration
  group (see the OrchestrationGroup aggregate).
- A child WorkflowInstance MUST carry complete provenance (parent, Watch,
  trigger, causal cycle, request identity) or none at all; a WorkflowInstance
  MUST NOT be started with partial provenance.
- A child WorkflowInstance's identity MUST be derived deterministically from
  its parent, Watch, and trigger, so that redelivering the same trigger is
  naturally idempotent rather than requiring a separate deduplication step.
- Configuration is validated once, at compile time. A compiled
  WorkflowDefinition MUST NOT contain an unreachable Stage, an unbounded
  cycle, an outcome route for a kind the named Activity cannot produce, a
  transition target that does not exist, or a route configuring both an
  explicit Await and a Watch gate.
- An Activity outcome kind that arrives for a Stage with no configured route
  for it MUST still be recorded and MUST block the instance
  (`InstanceBlocked`), not merely be silently ignored — the outcome durably
  happened even though the Stage never declared how to route it.
- A Watch MUST only match an event actually produced by the run belonging to
  its own currently-eligible parent, not merely a matching event type from
  anywhere in the system; this stops one of a Watch's own already-started
  children (e.g. a retry re-running the same Activity) from spuriously
  re-triggering the same Watch for a different eligible parent.
- Persisted events MUST be decoded through Orchestration's own event decoder
  before they enter the WorkflowInstance fold or any group claim read;
  malformed events are rejected, not silently coerced.
- Domain decision functions consume typed state and typed input and return
  event drafts to append (or a reason the input was ignored); they perform
  no IO and import no journal, clock, or adapter.
- Every consumer that needs to know whether a wait renders as "awaiting
  approval" externally, or how an `orchestration.*` event changes a
  WorkflowInstance's status, MUST derive it from the module's own
  `isApprovalAwaitingSignalKind` predicate and `orchestrationStatusTransitions`
  table respectively, rather than hand-matching event or signal types itself.
- A `done` route may declare `resourceTransitions` but no other outcome kind
  may. Such a route starts the reserved
  `orchestration.resource-transition` Signal wait, retaining the compiled
  transition list with the wait expectation. The configured transitions are
  an alternative to the route's Watch gate, not a second generic signal
  authority.
- Resource-transition matching is intentionally resource-agnostic:
  Orchestration narrows a live fact by the configured event/predicate and
  sends the candidate instance, WorkItem, transition list, and optional live
  fact to an injected evidence policy. The policy returns either no evidence
  or one transition plus the durable evidence identifier. Orchestration never
  imports Resources or re-derives resource correlation, capabilities, or
  provider trust itself.
- The composed service may run an entire ordinary signal acceptance through
  an operation coordinator. Production composition drains the
  resource-transition reactor before every signal acceptance, so a
  transition fact already in the journal is considered before a later
  signal can resolve the same wait. `acceptResourceTransition` also
  tolerates two concurrent applications of the same evidence issued under
  different command identities: on an append conflict it reloads and treats
  the transition as already applied when the evidence id appears in
  `acceptedSignalIds` or the instance has left `Waiting`, rethrowing only a
  genuine conflict.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `orchestration.instance-started` | A primary or child WorkflowInstance is created | This WorkflowInstance identity now exists, at its WorkflowDefinition's entry Stage. |
| `orchestration.stage-entered` | The instance moves to a new Stage | The named Stage is now current; its Activity has not yet been requested by this fact alone. |
| `orchestration.activity-requested` | An Activation is decided | An Activity with the given input is now the instance's pending Activation. |
| `orchestration.activity-started` | The executor confirms it has begun the pending Activation | The pending Activation is now running, not merely requested. |
| `orchestration.activity-outcome-accepted` | A non-waiting outcome is accepted for the pending Activation | The Activation is complete and its outcome is now part of the instance's history. |
| `orchestration.activity-execution-failed` | Execution reports that it could not complete the pending Activation | The failed Activation is durably accepted without an Activity outcome, before the instance is blocked. |
| `orchestration.activity-retried-for-runner-quota` | Execution reports that the pending Activation's runner hit a provider quota limit | The interrupted Activation is durably accepted without an Activity outcome and re-requested unchanged; no retry budget is consumed and no outcome is published. |
| `orchestration.activity-waiting` | The pending Activation itself reports a waiting outcome | The Activation is paused mid-execution on a named Signal; it has not completed. |
| `orchestration.signal-wait-started` | The instance begins waiting for a Signal | The instance is now Waiting for the stated Signal expectation, from any declared approval authority. |
| `orchestration.signal-accepted` | A Signal matching the current wait is accepted | The wait is now satisfied by this specific provider event; the instance resumes. |
| `orchestration.supplemental-activity-queued` | An authorised supplemental command is requested against an Active instance | The named Activity is now queued to run before the instance's own pending Stage activity resumes. |
| `orchestration.supplemental-activity-dequeued` | A queued supplemental activity is activated | This queue entry is no longer pending; it is now the instance's pending Activation. |
| `orchestration.repeat-counted` | A Stage-target route with a repeat bound is taken again | The route's repeat count has advanced towards its configured maximum. |
| `orchestration.retry-counted` | The same Stage is retried after a non-`done` outcome | The Stage-and-outcome-kind retry count has advanced towards its configured maximum. |
| `orchestration.instance-completed` | A transition target of `complete` is reached | The WorkflowInstance is finished; no further Activation or wait applies. |
| `orchestration.instance-blocked` | Retries/repeats are exhausted, a supplemental activity fails, a causal cycle is rejected, a Watch budget is exhausted, an outcome kind has no configured route, or an operator/explicit block command applies | The instance cannot proceed automatically and needs human attention. |
| `orchestration.instance-superseded` | Reserved; not currently produced | Would mark an instance as replaced by another; see Decisions. |
| `orchestration.child-requested` | A child WorkflowInstance's start is decided | A child is being started under this parent, Watch, and trigger. |
| `orchestration.child-started` | Immediately following a child request being accepted | The child WorkflowInstance now exists (recorded on the child's own stream). |
| `orchestration.child-completed` | A child reaches `completed` status | The child's completion is now a durable fact on the child's own stream, ready for its parent to consume. |
| `orchestration.child-completion-consumed` | The parent accepts its child's completion as a Signal | The parent has now processed this specific child's completion; it will not be reconsidered. |
| `orchestration.causal-activation-rejected` | A Watch trigger is recognised as a causal repeat within the same orchestration group | This trigger will not start a child; recorded on the parent, which is also blocked. |
| `orchestration.group-budget-exhausted` | A child claim fails because a Watch's per-group budget is already claimed out | This trigger did not start a child because the Watch's configured `maxPerGroup` is already met; the parent is blocked in the same append. |
| `orchestration.primary-claimed` | A WorkItem's primary WorkflowInstance ownership is claimed | This WorkflowInstance identity is now the WorkItem's one active primary. |
| `orchestration.group-claimed` | A child request's slot within a Watch's per-group budget is claimed | This request now counts against the Watch's `maxPerGroup` for this orchestration group. |

## Conceptual schema

**WorkflowInstance** (see [WorkflowInstance](domain/workflow-instance.spec.md) for full detail)

| Field | Type | Description |
| --- | --- | --- |
| `workflowInstanceId` | WorkflowInstance identity | Primary: caller-supplied. Child: must equal its deterministic request identity. |
| `workItemId` | WorkItem identity | The WorkItem this instance runs for; set once at creation. |
| `workflowName` | WorkflowDefinition name | The compiled WorkflowDefinition this instance is running. |
| `orchestrationGroupId` | Orchestration group identity | Shared by a primary and all of its descendant children. |
| `status` | closed vocabulary: `active` / `waiting` / `completed` / `blocked` / `superseded` | The instance's current run state. |
| `currentStage` | Stage name | The Stage the instance is currently in. |
| `pendingActivation` | optional Activation | The one Activation currently outstanding, if any. |

**Orchestration group claim** (see [OrchestrationGroup](domain/orchestration-group.spec.md))

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` / Watch scope | WorkItem identity, or (orchestration group, Watch) pair | Identifies the primary claim or the per-Watch budget claim. |
| `owner` / claimed request identities | WorkflowInstance identity, or set of request identities | The primary's sole owner, or the requests already counted against a Watch's budget. |

## Child components and interactions

| Component | Type | Owns | Interaction |
| --- | --- | --- | --- |
| [WorkflowInstance](domain/workflow-instance.spec.md) | aggregate | Identity, Stage, status, pending Activation, wait state, coordination history | Folds every `orchestration.*` fact on its own stream; every policy below reads its current view before deciding and appends to it. |
| [OrchestrationGroup](domain/orchestration-group.spec.md) | aggregate | Primary-workflow claim per WorkItem; per-Watch child budget claim per orchestration group | Arbitrates the "one primary" and "bounded children" invariants that WorkflowInstance creation depends on. |
| [Activation and transition policy](domain/activation-policy.spec.md) | policy/process | Starting an instance; dispatching an accepted outcome to a retry, a follow-on Activity, or the next transition; resolving a transition target | The central dispatcher; delegates to the retry, signal, and supplemental policies for input it does not itself resolve. |
| [Retry policy](domain/retry-policy.spec.md) | policy/process | Whether a non-`done` outcome retries the same Stage, and the resulting retry count | Consulted by the activation/transition dispatcher before it falls through to the configured OutcomeRoute. |
| [Signal policy](domain/signal-policy.spec.md) | policy/process | Starting and accepting explicit Signal waits; recording an Activity's own waiting outcome; approval authority acceptance (including reading a WorkItem's auto-approval consent) | Produces the events that resume a Waiting instance; shares transition-target resolution with the activation policy. |
| [Supplemental activity policy](domain/supplemental-policy.spec.md) | policy/process | Queueing and running out-of-band commands against an Active instance; actor-to-authority authorisation | Interrupts and later hands control back to the Stage's own pending Activation. |
| [Child workflow policy](domain/child-workflow-policy.spec.md) | policy/process | Deriving a child's deterministic request identity; claiming its group budget; detecting and rejecting causal repeats; reconciling a completed child back to its parent as a Signal | Depends on OrchestrationGroup for the budget claim and on WorkflowInstance to actually start the child. |
| [Workflow compiler](domain/compiler.spec.md) | adapter | Validating and compiling configured workflow definitions into the immutable runtime form every other component consumes, including Watch gates and approval-by-default | The boundary where operator-authored configuration becomes typed, branded, invariant-checked data. |
| [Workflow selector](domain/workflow-selector.spec.md) | policy/process | Matching a WorkItem's tags/kind/adapter facts to a configured workflow name | Consumed by another module's port, not by anything inside Orchestration itself. |
| Resource-transition matcher, evidence port, and reactor | application process | Generic waiting-instance matching, evidence-policy contract, checkpointed fact/wait-start processing, and transition application | The matcher supplies candidates to the injected policy without resource knowledge. The reactor processes both live configured facts and `SignalWaitStarted` catch-up; Bootstrap supplies its journal/checkpoint stores and the concrete capability-dispatched evidence policy. |
| [Orchestration projection](application/orchestration-projection.spec.md) | projection | A checkpointed, queryable `WorkflowInstanceView` per WorkflowInstance | Rebuilds purely from `orchestration.*` facts on workflow-instance streams; read by other modules' surfaces rather than by Orchestration's own command handling, which reloads state directly from the stream. |

## Dependencies and system role

- Kernel — event journal, envelope, closed-vocabulary, and command-context
  conventions; every stream read and append goes through it.
- Work (depends on: this module reads it) — a WorkflowInstance may only
  start for a WorkItem that exists and is open; a Signal's `auto` approval
  authority is accepted only when the WorkItem carries current auto-approval
  consent. Orchestration never writes `work.*` facts itself.
- Activities (depends on: this module reads it) — the Activity registry
  supplies the outcome kinds a Stage may route on and validates each
  Activity's input at compile time; the Outcome vocabulary is defined there
  and only interpreted here.
- Execution (depends on: this module carries its config and reads its Run
  projection) — a Stage's optional workspace mode is passed through an
  Activation request unmodified; a Watch trigger's owning WorkflowInstance is
  resolved through Execution's Run repository so a match is scoped to the
  run that actually produced the triggering event. Orchestration does not
  itself run or provision anything.
- Bootstrap (depends on this module) composes the resource-transition reactor
  with a concrete evidence policy and its journal/checkpoint stores. That
  policy is the boundary that knows resource capability and correlation.
  The reactor serializes its own `runOnce`/`drain` calls in-process; Bootstrap
  wires signal acceptance to drain the reactor first, with no external lock.
- Control-plane (depends on this module) — decides when to advance a
  WorkflowInstance, cancels or blocks one on a WorkItem cancellation, and
  reads its projection for tick and read-model purposes.
- Integrations (depends on this module) — translates inbound provider events
  into Signals (including watch-gate verdicts) and Activity outcomes accepted
  here, selects a workflow for newly admitted work through the
  workflow-selector port, and derives externally-visible approval/status
  state from `isApprovalAwaitingSignalKind` and `orchestrationStatusTransitions`
  rather than re-deriving it.
- API and board surfaces (depend on this module) — read the Orchestration
  projection to present WorkflowInstance state, deriving the same
  approval/status facts from `isApprovalAwaitingSignalKind` and
  `orchestrationStatusTransitions`; they do not append to its streams
  directly.

## Decisions, exclusions, and deferred capability

- No graph mutation, parallel positions, snapshots, or version entities: a
  WorkflowInstance has exactly one current Stage and one pending Activation
  at a time, and a compiled WorkflowDefinition is never edited in place —
  changing behaviour means compiling a new definition.
- `orchestration.instance-superseded` and the `superseded` status are
  modelled in the vocabulary and the fold, but nothing in the current
  decision policies produces this event; there is no supersession trigger
  yet.
- A primary claim and a per-Watch group budget claim are permanent for the
  life of an orchestration group: there is no command to release a primary
  claim (even after its WorkflowInstance completes or blocks) or to reclaim
  a budget slot.
- The module reserves the `workflow.` relation namespace in its
  configuration ownership, but does not currently establish any kernel
  relation facts; parent/child and WorkItem linkage are carried only as
  event payload fields (`workItemId`, `parentWorkflowInstanceId`), not as
  relations another module could query generically.
- Deciding *that* a workflow should start for a WorkItem — global selection
  — is explicitly out of scope; Orchestration exposes the pure
  candidate-matching function and lets the calling module decide when to
  invoke it.
