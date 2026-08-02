# Ambiguous-state escalation — design

Status: approved, ready for implementation planning.
Covers findings E1/E6 (`EXEC-RECOVERY`) and I4 (`INT-OUTBOX`) from
`docs/reports/2026-08-02-target-architecture-spec-findings.md`, and settles
the escalation threshold `docs/superpowers/specs/2026-08-02-agent-artifact-correlation-design.md`
(X1) deferred to "whatever gets decided for I4."

## Problem

Two unrelated-looking findings are the same problem. Execution's Recovery
records that a Run's true external state can't be determined (E1) but has
no path forward from there — a further `attempt` call just returns the same
ambiguous Run unchanged, forever. `RecoveryService.appendRecovered` (E6)
compounds this by throwing instead of recording `failed`/`ambiguous` for a
bad inspector report. Separately, GitHub's delivery `reconcile()` always
returns `Unknown` (I4) — an ambiguous or crash-interrupted delivery loops on
that status forever with no path to resolution either. Both are instances of
the same shape: **Wake attempted something with an external side effect, and
genuinely cannot determine from its own side whether that effect happened.**
Blind retry is unsafe (it risks duplicating the effect); doing nothing
forever strands real work or leaves an operator-facing signal (a PR comment,
a Run's outcome) permanently unresolved.

## Decisions

- **Resolution is an operator command, not just better auto-reconciliation.**
  Automatic reconciliation (querying the process/provider) stays as
  good-effort, bounded by a retry count — but genuine ambiguity is inherent
  (a crashed process or a dropped network response can be truly unknowable
  from Wake's side), so an explicit "declare the true outcome" command is
  the actual backstop, not a fallback for a design that should have avoided
  ambiguity.
- **Escalation triggers on a bounded attempt count**, not elapsed time —
  deterministic, testable, and matches the existing `retry.maxFailureRetries`-style
  pattern already used elsewhere in this codebase for retry bounds. The
  count is operator-configurable per domain with a sensible default (e.g.
  3), not hardcoded — consistent with how `maxFailureRetries` is already a
  config knob, not a constant.
- **Escalation surfacing is domain-specific**, not one uniform mechanism:
  - **Execution** — an escalated Run blocks its owning WorkflowInstance via
    the existing `WorkflowStatus.Blocked` (already wired: Control-plane's
    work-cancellation-policy already blocks workflows with a reason
    string). A Run's ambiguity genuinely stops workflow progress, so this
    reuses plumbing that already exists rather than inventing new
    visibility.
  - **Integrations (delivery)** — an escalated delivery gets its own
    durable, queryable marker on the existing `DeliveryIntentView`, not
    tied to blocking a workflow. Delivery ambiguity doesn't necessarily
    stop the workflow that requested it; forcing it through `Blocked` would
    misrepresent that.
  - **Integrations (artifact verification, X1)** — inherits this same
    shape: after the same bounded attempt count, an ambiguous artifact
    verification gets a delivery-style escalated marker (it's the same kind
    of "read kept failing" state, just for a query instead of a write), not
    full resolution machinery — see below.
- **Resolution reuses existing outcome/status vocabulary, tagged by actor,
  not a new vocabulary fork.** `actor` isn't a new field — it's already
  mandatory on every event via the kernel's `EventActorKind`
  (`System | Operator | Agent | Integration`), threaded through every event
  draft via `context.actor` today. An operator's declared Run outcome is
  recorded as the same `done`/`failed` kind the automated path would have
  used, just with `actor: Operator`; an operator's declared delivery
  outcome is the same `confirmed`/`failed`, same treatment. Nothing that
  already reads outcome/delivery kind needs to change; provenance is
  available to anything that checks `actor`, ignorable by anything that
  doesn't.
- **The operator command only accepts a declaration against an actually-
  escalated Run/delivery** — validated against the escalated state, not
  against a live or already-resolved one. An operator can't override a Run
  that's still in progress or already resolved just because the command
  exists.

## Architecture

**Shared shape (both domains implement this independently, not via shared
code — the domains don't share a reconciliation abstraction today and this
design doesn't introduce one):**

1. A bounded number of automatic reconciliation attempts (Execution: lease/
   process inspection; Integrations: provider reconcile query), each
   recording its own attempt.
2. On exceeding the configured attempt count, escalate:
   - Execution: call the existing `orchestration.block(workflowInstanceId,
     reason: 'run-ambiguous-after-N-attempts', context)`.
   - Integrations: mark the `DeliveryIntentView` entry escalated (new field
     or status value on the existing view — exact shape is implementation-
     plan detail).
3. A new operator-facing command per domain (`execution.resolve(runId,
   outcome, context)`, `integrations.resolveDelivery(intentId, outcome,
   context)`), each guarded to only accept a target that's actually
   escalated, each recording the declared outcome with `actor: Operator`
   using the existing outcome/delivery vocabulary.
4. Execution's resolution, once recorded, unblocks the WorkflowInstance the
   same way any other outcome acceptance would (no special-casing needed —
   Orchestration already doesn't care how an outcome was produced, only
   what it is).
5. X1's artifact-verification reactor (already designed) gains the same
   bounded-attempt-then-escalate step for its `ambiguous` case, using
   Integrations' new escalated-marker mechanism from step 2 rather than a
   third bespoke mechanism.

## Error handling

- **A Run/delivery resolved automatically before the operator command is
  used** (e.g. reconciliation happens to succeed on attempt N, or a delayed
  provider confirmation arrives) — the escalated state must be clearable by
  the same automatic path that would have resolved it earlier; escalation
  is a visibility signal, not a lock that only an operator command can
  release.
- **An operator command targeting a non-escalated Run/delivery** — rejected
  outright (see decisions above); prevents overriding live or already-
  resolved state.
- **Two operators (or an operator and a delayed automatic resolution) racing
  to resolve the same item** — first-write-wins, matching the idempotent-
  command conventions already used throughout this codebase; the loser's
  attempt is a no-op returning the existing resolution, not an error.

## Testing

- Unit: bounded-attempt-count escalation for each domain — N-1 attempts
  stay unescalated, attempt N escalates (Execution: WorkflowInstance
  transitions to `Blocked`; Integrations: `DeliveryIntentView` entry marked
  escalated).
- Unit: operator resolution command — accepted against an escalated target
  with `actor: Operator` recorded on the resulting fact; rejected against a
  live or already-resolved target.
- Unit: race — two resolution attempts against the same escalated item,
  first wins, second is a no-op.
- E2E (fake provider/fake runner, composed production services): a Run
  that never resolves through the fake's reconciliation path escalates,
  blocks its WorkflowInstance, and an operator resolution command unblocks
  it with the declared outcome. A parallel scenario for an escalated fake
  delivery.

## Deferred / out of scope

- No shared reconciliation abstraction between Execution and Integrations —
  each domain implements its own bounded-attempt loop against its own
  external system; unifying that (if ever) is separate scope.
- The exact default attempt-count value and its config key names are
  implementation-plan detail, not decided here beyond "operator-configurable,
  small integer default."
- Cross-references: this closes the "Deferred" item in X1's spec
  (`docs/superpowers/specs/2026-08-02-agent-artifact-correlation-design.md`)
  that pointed here — update that spec's Deferred section to reference this
  one instead of leaving it as an open question.
