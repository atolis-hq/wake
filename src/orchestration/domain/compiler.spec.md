# Workflow compiler — Component Specification

## Type, purpose, and scope

Adapter. This component is the sole boundary where an operator-authored
workflow definition — raw configuration — becomes the immutable,
invariant-checked `CompiledWorkflow` every other Orchestration component
consumes. It validates once, at compile time, so that nothing downstream
needs to re-parse or re-check configuration.

## Responsibilities and boundaries

The compiler owns parsing a workflow definition's shape, resolving its
entry Stage, validating every Stage's Activity and input against the
Activity registry, validating every outcome route's target and follow-on
Activities, validating every Watch's stages and target workflow, checking
Stage reachability and cycle-boundedness, and freezing the result. It does
not decide which Activity outcome kinds exist — the Activity registry
(Activities) is the sole authority consulted for that — and it does not
validate a Watch's target workflow's own internal structure, only that its
name is recognised.

## Core policies, invariants, and behaviours

- Compilation MUST fail if a configured stage id is a reserved target
  (`done`, `await-human`, or `wait`) — these are never ordinary Stage names;
  they compile to a `complete`, implicit-wait, or resource-transition-wait
  target respectively.
- The entry Stage MUST be one of the configured stages; when no `entry` is
  configured, the first declared stage is used.
- Every Stage's `activity` and `with` input MUST validate against the
  supplied Activity registry; an unknown Activity or invalid input fails
  compilation.
- Every outcome route's key MUST be one of the named Activity's declared
  outcome kinds; a route for a kind the Activity cannot produce fails
  compilation.
- Every outcome route's `then` MUST be `done`, `await-human`, `wait`, or another
  configured stage; any other value fails compilation.
- A route MUST NOT configure both `await` and `watchGates`; declaring both
  fails compilation.
- A route's `watchGates` MUST list exactly one entry; today's decision
  policies support exactly one Watch gate per route, not several. Each
  entry's `watch` (a bare string, or `{ watch, onReject: { then } }`) MUST
  reference a Watch id already declared in the same workflow's `watches`; an
  undeclared reference fails compilation. `onReject.then` defaults to the
  route's own Stage when omitted, and MUST otherwise be `done`,
  `await-human`, or another configured stage, validated the same way as a
  route's own `then`.
- `wait` is valid only on a `done` route with one or more
  `resourceTransitions`. Each transition MUST declare its own `then`, and that
  target MUST NOT be `wait`.
- A `done` outcome route with neither an explicit `await` nor `watchGates`
  compiles an implicit Await gating on the `approved` Signal from `human` —
  approval-by-default — unless its Stage sets `requiresApproval: false`. A
  non-`done` outcome kind is never subject to approval-by-default. This
  compiled Await is otherwise indistinguishable from one the operator wrote
  explicitly; downstream components have no notion of "default" vs
  "explicit".
- Every follow-on Activity listed on a route MUST validate its own name and
  input the same way a Stage's own Activity does.
- An `await` config's `from` list MAY reference `human` or `auto` directly;
  a `{ kind: watch, id }` entry MUST reference a Watch id already declared
  elsewhere in the same workflow's `watches`, checked before any Stage is
  compiled — an undeclared watch reference fails compilation.
- Every Watch id MUST be unique within its workflow; every stage named in a
  Watch's `while.stages` MUST be a configured stage; every Watch's target
  `workflow` MUST be a member of the caller-supplied set of known workflow
  names (which defaults to just the workflow's own name when the caller
  supplies none, meaning a Watch can then only target its own workflow).
- Every configured Stage MUST be reachable from the entry Stage by following
  Stage-kind transition targets; an unreachable Stage fails compilation.
- Any Stage-target route whose target can reach back to its own origin
  Stage MUST declare a `repeat` bound; a cycle-closing route with no bound
  fails compilation — this is the compile-time guarantee behind the
  runtime invariant that no decision path can loop unboundedly.
- The compiled result — the workflow, its stages, each stage's route map,
  each route, its watches, and its commands — MUST be deeply frozen; nothing
  downstream may mutate a compiled definition in place.

## Conceptual schema

**CompiledWorkflow** — the immutable runtime form of one configured
workflow.

| Field | Type | Description |
| --- | --- | --- |
| `name` | WorkflowDefinition name | The workflow's own compiled, branded name. |
| `entry` | Stage name | The Stage a new primary or child instance starts in. |
| `stages` | map of Stage name to CompiledStage | Every configured Stage, keyed by name. |
| `commands` | map of Command name to CompiledSupplementalCommand | Every configured supplemental command, keyed by name. |
| `watches` | list of CompiledWatch | Every configured Watch, in declared order. |

**CompiledStage**

| Field | Type | Description |
| --- | --- | --- |
| `activity` | Activity name | The Activity this Stage activates. |
| `with` | unknown, Activity-validated | The Activity's configured input. |
| `execution` | optional execution config | Workspace mode / runner pool hint for this Stage's own Activations. |
| `on` | map of outcome kind to CompiledOutcomeRoute | The configured consequence for each outcome kind this Activity may produce. |

**CompiledOutcomeRoute**

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | `<workflow>:<stage>:<outcomeKind>`, used as the repeat-count key. |
| `target` | TransitionTarget | The resolved Stage, `complete`, or implicit-wait target. |
| `reentryTarget` | TransitionTarget | The owning Stage materialised at compile time; approval rejection resumes through this explicit target. |
| `repeat` | optional `{ max }` | Present when this route closes a cycle; required whenever it does. |
| `retry` | optional `{ max }` | Present when a non-`done` outcome at this route may retry the Stage. |
| `activities` | optional list of CompiledFollowOnActivity | Follow-on Activities to run, in order, before transitioning. |
| `await` | optional CompiledAwait | Present when this route gates its target behind an explicit Signal (operator-written or approval-by-default). Mutually exclusive with `watchGates`. |
| `watchGates` | optional list of CompiledWatchGate | Present when this route gates its target behind a Watch's verdict; today always exactly one entry. Mutually exclusive with `await`. |

**CompiledWatchGate**

| Field | Type | Description |
| --- | --- | --- |
| `watch` | Watch identity | The Watch whose verdict this gate waits for. |
| `onRejectTarget` | TransitionTarget | The resolved Stage, `complete`, or implicit-wait target to reach on a rejecting verdict; defaults to the route's own Stage when the operator didn't configure `onReject`. |

**CompiledWatch**

| Field | Type | Description |
| --- | --- | --- |
| `id` | Watch identity | Unique within its workflow. |
| `workflow` | WorkflowDefinition name | The child workflow this Watch starts, validated against known workflow names. |
| `while` | `{ stages, statuses }` | The parent Stage/status combinations this Watch is active for. |
| `on` / `schedule` | optional event names / cron | The trigger; at least one of the two is always present. |
| `maxPerGroup` | positive integer | The per-orchestration-group child budget this Watch is bound by. |

## Dependencies and system role

- Activities — the registry this component consults to validate every
  Activity name, input, and declared outcome kind; the compiler never
  invents or assumes an outcome kind.
- Execution — supplies the `WorkspaceMode` vocabulary validated for a
  Stage's `execution.workspace`.
- Activation and transition policy, retry policy, signal policy,
  supplemental policy, child workflow policy, workflow selector (all depend
  on this component) — every one of them reads only the compiled,
  invariant-checked form; none re-validates raw configuration.

## Decisions, exclusions, and deferred capability

- Compilation happens once per named workflow; there is no hot recompilation
  or in-place edit of a compiled definition — changing behaviour means
  compiling a new definition.
- Compiling one workflow does not itself verify that another workflow it
  references by name (via a Watch's `workflow`) successfully compiles or has
  a compatible structure; only the referenced name's presence in the
  caller-supplied known-workflow-names set is checked.
- There is no versioning or migration of a previously compiled definition;
  the module reserves no version-entity concept for a `CompiledWorkflow`.
