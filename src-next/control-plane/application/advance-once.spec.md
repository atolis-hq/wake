# Advancement — Component Specification

## Type, purpose, and scope

Policy/process. Advancement is the single bounded, side-effecting call that
makes at most one unit of cross-module progress: it recovers interrupted
Execution state, reconciles Orchestration outcomes that were never accepted,
selects one pending unit of orchestration work, dispatches it to Execution
with its resolved Resources, and records the outcome. This component also
owns the Tick pipeline: the fixed stage sequence that wraps one Advancement
call with the surrounding poll/translate/react/deliver stages of one Wake
tick, producing the composed callback the Tick and Resident Hosts repeat.

## Ubiquitous language

- **Recovery** — the `recoverActive` call Advancement makes to Execution
  before anything else, so interrupted Runs owned by the control-plane host
  are reconciled before new selection.
- **Reconciliation** — finding a pending activation whose Execution Run
  already succeeded with an outcome that Orchestration has not yet accepted,
  and accepting it, in preference to starting new dispatch.
- **Selection** — choosing which pending activation to dispatch next when no
  reconciliation candidate exists.
- **Runner pipeline** — the fixed ordered stage sequence
  (`catchUpProjections` → `runSchedules` → `react` → Advancement →
  `catchUpProjections` → `deliver` → `catchUpProjections` → `react`) that
  one call to `RunnerPipeline.run` performs, wrapping exactly one
  Advancement call. `poll` and `translateInbound` — the externally
  rate-limited half of a tick — run on a separate `IntakePipeline` instead,
  not embedded in this sequence; see control-plane's `tick-host.spec.md`
  for why the two are split across independently-scheduled hosts.

## Responsibilities and boundaries

Advancement owns the recovery → reconciliation → selection → dispatch →
outcome-acceptance sequence for one call, and (as the Tick pipeline) the
ordering of the IO stages around that one call for one tick. It does not
define what makes an activation pending or a workflow waiting — it reads
Orchestration's own readiness reports. It does not implement `poll`,
`translateInbound`, `react`, or `deliver` — those stages are supplied by the
caller (bootstrap composition) and only sequenced here. It does not decide
runner eligibility itself — it calls an injected `runnerIneligibility`
supplier and passes the result through to Execution unchanged.

## Core policies, invariants, and behaviours

- When `maxProgress < 1`, Advancement MUST return `{ kind: 'exhausted',
  progressCount: 0 }` immediately, performing no recovery, reconciliation,
  selection, or dispatch.
- Otherwise Advancement MUST call Execution's `recoverActive` (when
  supplied) for the control-plane owner, then Orchestration's
  `reconcileChildCompletions`, before reading any pending activation.
  `reconcileChildCompletions` runs unscoped, regardless of any `workItemId`
  option.
- `maxProgress` bounds only whether Advancement proceeds at all; it MUST NOT
  cause internal looping. A caller wanting more than one accepted outcome
  MUST call Advancement again — this is what the module-wide "at most one
  accepted outcome per call" invariant means in this component.
- Listing pending activations MUST be scoped to `options.workItemId` when
  given, and MUST cover all WorkItems otherwise.
- Reconciliation MUST take priority over new selection: Advancement scans
  pending activations in the order Orchestration returned them and accepts
  the first one whose Execution Run already succeeded with a defined outcome
  not yet present in that workflow's accepted outcomes, returning
  `progressed` for it without attempting new dispatch.
- When no reconciliation candidate exists, Advancement selects the first
  pending activation in Orchestration's returned order — an unordered,
  first-encountered choice. Advancement does not consult Dispatch Policy's
  fairness ordering.
- When there is no pending activation at all, Advancement checks
  Orchestration's waiting workflows: it reports the first waiting instance
  found (`kind: Waiting`) or `no-work` if none are waiting.
- Advancement does not consult the global dispatch pause (`pausedUntil`) at
  all; only the injected `runnerIneligibility` result (default: empty set)
  is applied, and only to the Execution `attempt` call, by including
  `ineligibleRunners` in the attempt context solely when that set is
  non-empty.
- Selecting a candidate MUST mark its activation started in Orchestration
  before the Execution attempt is made, regardless of whether that attempt
  later succeeds or fails.
- Before dispatch, Advancement resolves the selected WorkItem's correlated
  Resources and passes only the ones that currently resolve (a missing
  correlation target is silently dropped from the attempt context, not
  treated as an error).
- When the Execution attempt succeeds with a defined outcome, Advancement
  MUST accept that outcome into Orchestration before returning `progressed`.
  When the attempt does not succeed, Advancement returns `Blocked` with the
  workflow instance id and the run's failure message (defaulting to
  `'execution failed'`); it does not itself record a block or failure fact —
  Execution's own run-failure event is the durable record of what happened.
- The Runner pipeline MUST run its eight stages in the fixed order given
  above, awaiting each stage fully before starting the next, exactly once
  per `run` call, and MUST return the `AdvanceResult` of the embedded
  Advancement call. `catchUpProjections` runs three times (before
  `runSchedules`, after Advancement, after `deliver`) so each stage
  observes projections caught up to the facts the prior stage produced.
  `react` runs twice: once before Advancement, once for delivery outcomes
  after `deliver`. A `finally` block runs `catchUpProjections` a fourth
  time regardless of outcome, including when an earlier stage throws.
- `RunnerPipeline.run`'s `signal` parameter defaults to a fresh,
  never-aborted `AbortController`'s signal when the caller omits one.

## Conceptual schema

**AdvanceOptions** (per-call input; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `workItemId` | WorkItem identity, optional | Scopes pending-activation listing to one WorkItem; omitted means all. |
| `maxProgress` | integer | Gate only: `< 1` short-circuits to `exhausted`; otherwise unused. |

**AdvanceResult** (per-call output; not durable)

| Field | Type | Description |
| --- | --- | --- |
| `kind` | closed vocabulary: `no-work` / `progressed` / `waiting` / `blocked` / `exhausted` | What this call accomplished. |
| `activationId`, `runId` | identities (progressed only) | The activation and Run whose outcome was accepted. |
| `workflowInstanceId` | identity (waiting/blocked only) | The workflow instance reported waiting or blocked. |
| `reason` | string (blocked only) | The Execution failure message, or a default. |
| `progressCount` | integer (exhausted only) | Always `0`; no internal loop ever increments it. |

## Dependencies and system role

- Orchestration — supplies pending/waiting readiness, accepts outcomes,
  marks activations started, and reconciles child completions; Advancement
  never redefines this readiness itself.
- Execution — recovers interrupted Runs, executes the selected activation,
  and lists Runs for reconciliation.
- Resources — resolves the selected WorkItem's correlated Resources before
  dispatch.
- Control Plane view (indirect) — the composed `runnerIneligibility`
  supplier reads the projection and calls `ineligibleRunners`; Advancement
  itself depends only on the injected async function, not the projection.
- Kernel — Clock, IdGenerator, and command-context/correlation conventions
  for every downstream command Advancement issues.
- Tick and Resident Hosts (dependent) — in production composition, wrap the
  Tick pipeline (not the bare Advancement call) as their repeated unit of
  work.
- The API `advance` command (dependent) — invokes the bare Advancement
  function directly, without the surrounding Tick pipeline stages, so an
  API-triggered advance performs no poll/translate/deliver.

## Decisions, exclusions, and deferred capability

- Selection is unordered first-pending-candidate; Dispatch Policy's
  fairness-ordered `select` exists as pure logic but is not called from
  here.
- `HostStopReason.Paused` is never produced by any path reachable through
  Advancement, because Advancement never reads or acts on the global
  dispatch pause recorded in the Control Plane view.
