# Activation and transition policy — Component Specification

## Type, purpose, and scope

Policy/process. This component starts a WorkflowInstance (primary or child)
and decides, for a `done`-or-non-`done` Activity outcome, what the
WorkflowInstance appends next: a retry of the same Stage, a configured
follow-on Activity, a dequeued supplemental activity, or a transition to the
next Stage, completion, or a Signal wait. It is the central dispatcher named
in the module specification: it resolves what it can directly and delegates
the rest to the retry, signal, and supplemental policies.

## Responsibilities and boundaries

This component owns composing the ordered event data for starting an
instance, deciding whether an incoming outcome is for the current pending
Activation at all, and — once accepted — the dispatch order between retry,
supplemental continuation, follow-on Activities, and Stage/completion/wait
transitions. It also owns resolving a `TransitionTarget` (Stage, `complete`,
or an implicit Signal wait) into the concrete facts that follow from reaching
it, shared by a direct route and by a resumed Signal wait.

It does not itself decide whether a non-`done` outcome may retry (retry
policy), whether a Signal is a valid match with acceptable authority (signal
policy), or whether a supplemental command may be queued and how its
completion is judged (supplemental policy) — it calls into each and folds
their event data into the same append. It does not claim a WorkItem's
primary ownership or a Watch's child budget itself; a primary start requires
that claim to already have succeeded before this component is invoked, and a
child start requires complete provenance to already be validated.

## Core policies, invariants, and behaviours

**Starting an instance**

- Starting a primary instance MUST append, in order: `InstanceStarted`,
  `StageEntered` (for the WorkflowDefinition's entry Stage), then
  `ActivityRequested` for that Stage's configured Activity.
- Starting a child instance MUST prepend `ChildRequested` then `ChildStarted`
  (both on the child's own stream) before the same three facts.
- The entry Activation's `execution` config is carried through unmodified
  from the entry Stage's own configuration.

**Accepting an outcome**

- An outcome MUST be ignored, not appended, unless its `activationId` matches
  the instance's current pending Activation and that Activation's id is not
  already present in `acceptedOutcomes`; this is the duplicate/replay guard —
  redelivering an already-accepted outcome is a no-op, not an error.
- A `waiting`-kind outcome MUST be handed to the signal policy
  (`acceptWaitingOutcome`) before any of the rules below apply; it is not a
  terminal outcome and never reaches retry, follow-on, or transition
  dispatch.
- For any other outcome kind, `ActivityOutcomeAccepted` MUST be the first
  event appended, recording the outcome as part of the instance's history
  regardless of what happens next.
- If the pending Activation is itself a supplemental activity, dispatch MUST
  go straight to the supplemental policy's completion handling and MUST NOT
  consult the current Stage's configured `OutcomeRoute`, retry policy, or
  follow-on Activities for that outcome at all.
- Otherwise, the outcome kind MUST be looked up against the current Stage's
  configured routes. An outcome kind with no configured route MUST NOT be
  silently ignored: `InstanceBlocked` (reason `unconfigured outcome
  <kind>`) is appended after the `ActivityOutcomeAccepted` fact, so the
  outcome is durably recorded as resolved and the instance stops rather than
  leaving an Activation that looks unresolved.
- For a non-`done` outcome with a configured route: the retry policy is
  consulted first. If it grants a retry, the retry policy's events are
  appended and dispatch stops; otherwise the route's transition is resolved
  (see below).
- For a `done` outcome: if the instance has a non-empty supplemental queue,
  the next queued supplemental activity is dequeued and requested instead of
  advancing the Stage's own route. Otherwise, if the route configures
  further follow-on Activities and the current Activation has not yet run
  through all of them, the next follow-on is requested. Only once neither
  applies does the route's transition resolve.

**Resolving a transition**

- A route whose `watchGates` is configured MUST always emit
  `SignalWaitStarted` for the reserved `orchestration.watch-gate-verdict`
  Signal, regardless of what the route's own transition target is — a Watch
  gate intercepts even a `Stage` or `complete` target the same way an
  `await` does. The expectation's `from` is exactly the gate's own Watch
  authority plus `human` (either may satisfy it), its `resume` target is the
  route's own target, and its `onRejectResume` target is the gate's
  compiled rejection target. The compiler guarantees a route never
  configures both `watchGates` and `await`.
- A route whose `await` is configured MUST always emit `SignalWaitStarted`
  for that Signal, regardless of what the route's own transition target
  is — an await gate intercepts even a `Stage` or `complete` target; the
  target is only reached later, once the Signal is accepted.
- A `Stage`-kind target that closes a cycle (its route declares `repeat`)
  MUST have its repeat count checked before entering the target Stage: at or
  beyond `repeat.max`, the instance is blocked (`InstanceBlocked`) instead of
  transitioning, and `RepeatCounted` is not appended; below the bound,
  `RepeatCounted` is appended before `StageEntered`/`ActivityRequested`.
- A `complete` target MUST emit `InstanceCompleted` and nothing else.
- An implicit-wait (`await-signal`) target MUST emit `SignalWaitStarted` for
  the configured signal, with no `from` restriction of its own (this is
  distinct from a route's explicit `await`, which does carry authority).
- A `Stage`-kind target with no repeat bound to check MUST emit
  `StageEntered` then `ActivityRequested` for the target Stage's configured
  Activity, carrying that Stage's own `execution` config.
- The same transition resolution is used both when a route is reached
  directly and when a Signal wait resumes to a declared `resume` target; it
  applies no repeat counting in the resumed case, since the counted route
  transition already happened when the wait began.

## Event catalogue

| Event | Occurs when | Business meaning |
| --- | --- | --- |
| `orchestration.instance-started` | `startInstance` is accepted | The instance now exists at its WorkflowDefinition's entry Stage. |
| `orchestration.stage-entered` | Start, transition, or wait resume reaches a Stage | The named Stage is now current. |
| `orchestration.activity-requested` | Start, transition resolution, or a resumed wait with no `resume` target | The named Activity is now the pending Activation. |
| `orchestration.activity-outcome-accepted` | A non-waiting outcome is accepted for the pending Activation | The outcome is now part of the instance's history. |
| `orchestration.repeat-counted` | A cycle-closing route is taken again, below its bound | The route's repeat count has advanced. |
| `orchestration.instance-completed` | A `complete` target is resolved | The instance is finished. |
| `orchestration.instance-blocked` | A repeat bound is exceeded, or an accepted outcome's kind has no configured route on the current Stage | The instance cannot proceed automatically. |
| `orchestration.signal-wait-started` | An `await` route, a `watchGates` route, or an implicit-wait target resolves | The instance is now waiting for the stated Signal. |

## Conceptual schema

**OrchestrationDecision** — the result type every policy in this module
(this one and the retry, signal, and supplemental policies it delegates to)
returns; not itself a durable entity.

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `append` / `ignored` | Whether the input produced new facts to append. |
| `events` | list of event data | Present only when `kind` is `append`; the facts to append, in order. |
| `reason` | string | Present only when `kind` is `ignored`; why the input was not accepted or was a duplicate. |

## Dependencies and system role

- WorkflowInstance (aggregate) — every decision here reads the current
  `WorkflowInstanceView` before deciding and folds its own output back
  through that aggregate; this component never appends directly.
- Retry policy — consulted for every non-`done` outcome before this
  component falls through to its own transition resolution.
- Signal policy — receives `waiting`-kind outcomes outright, and this
  component's `resumeToTarget` transition resolution is reused by the signal
  policy when a Signal wait resumes.
- Supplemental policy — receives dispatch outright when the pending
  Activation is itself supplemental, and is consulted again when a `done`
  outcome finds a non-empty supplemental queue.
- Child workflow policy — supplies the child-start event data
  (`ChildRequested`/`ChildStarted`) this component prepends when starting
  with parent provenance.
- Activities — the outcome-kind vocabulary (`done` and friends) this
  component switches on, and the compiled Activity/route shape it reads.
- Workflow compiler — supplies the `CompiledWorkflow` this component reads
  Stage, route, and Activity configuration from; never re-parses raw config.

## Decisions, exclusions, and deferred capability

- `orchestration.instance-superseded` is not produced by this component; see
  the module specification.
- Explicitly marking an Activation as started, or blocking an instance
  directly, are accepted as separate direct commands outside outcome
  dispatch; their acceptance and no-op semantics are the WorkflowInstance
  aggregate's own folding rules, not a decision this component makes.
- A cycle-closing route's bound is enforced only against the Stage-target
  case; the compiler already rejects any cycle-closing route that omits
  `repeat` entirely, so no runtime path exists for an unbounded cycle.
