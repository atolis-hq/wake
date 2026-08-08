# Stage/watch lifecycle scenario suite — design

## Goal

Turn six informally-described lifecycle scenarios (plain two-stage workflows
with retries, and dark-factory workflows with watch-triggered review children)
into a deterministic, regression-proof test suite in `test-next/`, using only
existing production mechanisms. No `src-next/` production code changes are
required — every behaviour below is already implemented and independently
proven by existing tests; what's missing is the six scenarios assembled
end-to-end and named so a future change that breaks one is caught.

A second, non-CI phase updates the `~/wake-next` Wake home (`config.yaml`,
`config.workflows.yaml`, `fake-scenarios.yaml`) so the same six scenarios can
be watched running for real against the `atolis-hq/wake-test` GitHub repo with
fake runners, for visual confidence — not a regression test.

## Existing mechanisms this suite relies on

- Two-stage `default`-shaped workflow, `on.done.then` routing
  (`golden-path.test.ts`).
- Per-stage `retry.max`, counted by `<stage>:<outcomeKind>`, granting a fresh
  Activation on retry (`orchestration/domain/retry-policy.spec.md`,
  `retry-boundary.test.ts`).
- Retry exhaustion falling through to `await-human`, then a human `acceptSignal`
  resuming the interrupted Activation without resetting the retry budget
  (`orchestration/domain/signal-policy.spec.md`, `blocked-reply.test.ts`).
- `watches` config: a Watch spawns a child WorkflowInstance on a matching
  event, the child signals its parent exactly once on completion via
  `orchestration.child-completed`, and never becomes primary
  (`orchestration/domain/child-workflow-policy.spec.md`,
  `child-completion.test.ts`).
- A Watch's per-group `maxPerGroup` budget: exhausting it on a genuine new
  trigger appends `GroupBudgetExhausted` then `InstanceBlocked` **on the
  parent** (`child-loop-guard.test.ts`).
- A child that never reaches a completing outcome (its own `retry.max`
  exhausted with no successful/rejected verdict) ends `blocked` and is never
  reconciled to its parent — confirmed by reading
  `orchestration/application/request-child.ts`
  (`reconcileChildCompletions` only completes children whose `status ===
  Completed`). The parent legitimately stays `waiting`; the child's own
  blocked state is what a human inspects (already surfaced by the board's
  child-run card, `surfaces/web/src/features/board/board-card.tsx`).
- GitHub label reconciliation (`wake:status.*`, `wake:stage.*`,
  `wake:workflow.*`) and outbound comment delivery are independently owned and
  tested (`integrations/github/application/wake-labels.ts`,
  `integrations/github/outbound-delivery.spec.md`); this suite asserts they
  fire (one label-reconcile-worthy event per stage transition) without
  re-testing their own translation rules.

## Two semantically distinct "stuck" states (load-bearing distinction)

- **`rejected`** — the review activity produced a verdict: it looked and said
  no. A business outcome; routes its own workflow to `done`, successfully
  signalling the parent to retry `implement`. Repeated rejections are bounded
  by the Watch's `maxPerGroup` budget, which blocks the **parent** once
  exhausted — this is what stops an infinite auto-retry loop when review
  feedback keeps arriving (scenario 2b).
- **`blocked`** — the review activity could not produce a verdict at all
  (crash/timeout/technical failure), same semantics as any other Activity's
  retry-exhaustion. The **child** ends blocked; nothing is forced into a fake
  verdict on the last attempt, and the parent is not affected — it stays
  `waiting`, unaware anything happened, exactly like any other watch that
  hasn't fired yet (scenario 2c). A human deals with the stuck review
  directly, not by unblocking the parent.

These must stay distinct: forcing a technical failure into an implicit
`rejected` verdict on the final retry would fabricate a review that never
happened.

## Scenarios and their test files (`test-next/e2e/scenarios/`)

All six run against `TestWorld` (in-memory orchestration/execution/watch
services), using `defineScenario` for Given/When/Then metadata, following the
existing `E2E-ORCH-*` naming and structural conventions.

1. **`lifecycle-happy-path.test.ts`** (`E2E-LIFECYCLE-001`) — `default`-shaped
   two-stage workflow (`refine` → `implement` → `done`); each stage's agent
   succeeds first try. Asserts both stage transitions, one outbound-worthy
   event per stage, and final `state: open`/workflow `status: completed`.
2. **`lifecycle-retry-recovery.test.ts`** (`E2E-LIFECYCLE-002`) — same
   workflow; `refine`'s activity fails once then succeeds
   (`retry.max: 1`); `implement`'s activity fails twice then succeeds
   (`retry.max: 2`). Asserts `retryCounts` per stage and that both are
   independent counters.
3. **`lifecycle-retry-limit.test.ts`** (`E2E-LIFECYCLE-003`) — `refine`'s
   activity fails three times, exceeding `retry.max: 2`, landing on
   `await-human`; a human `acceptSignal` resumes a fourth attempt which
   succeeds; `implement` then succeeds first try. Asserts the instance does
   not auto-retry past the bound, that the resuming signal doesn't reset
   `retryCounts`, and eventual completion.
4. **`dark-factory-happy-path.test.ts`** (`E2E-DARKFACTORY-001`) — `refine`
   stage awaits a `plan-review` Watch child that approves first try;
   `implement` stage awaits a `pr-review` Watch child that rejects once (one
   retry-and-succeed inside the child, or a same-child single reject-then-new-
   trigger — whichever the existing plumbing makes simplest) then approves on
   the second trigger, within `maxPerGroup: 2`. Asserts the parent's own
   stage/status is never mutated by a watch directly (only via the signal it
   produces), and the workflow reaches `completed`.
5. **`dark-factory-loop-guard.test.ts`** (`E2E-DARKFACTORY-002`) — the
   `pr-review` Watch child rejects three separate times (three distinct
   triggers, i.e. `implement` retried three times); `maxPerGroup: 2` is
   exhausted on the third trigger. Asserts `GroupBudgetExhausted` then
   `InstanceBlocked` on the **parent**, and that no fourth child is requested.
6. **`dark-factory-child-error.test.ts`** (`E2E-DARKFACTORY-003`) — the
   `pr-review` Watch child's own activity fails three times (technical
   failure, `retry.max: 2`), never producing a verdict, landing the child on
   `await-human`/`blocked`. Asserts the child's status is `blocked`, the
   parent's status remains `waiting` and unaffected, and no
   `child-completed`/`child-completion-consumed` fact is ever recorded for
   that child.

Each file also gets a short reference block (or a shared
`test-next/e2e/SCENARIOS.md`) restating the Given/When/Then in plain prose, so
the distinction between `rejected`-budget-blocks-parent (2b) and
`blocked`-child-doesn't-touch-parent (2c) is documented, not just encoded in
assertions.

## Phase 2 — live demo in `~/wake-next` (not part of this suite, not CI)

Once the six pass, extend `~/wake-next`'s `config.workflows.yaml` `dark-factory`
workflow with an `implement`-stage `pr-review` Watch (currently only `refine`
has a Watch), and extend `fake-scenarios.yaml` with `REJECTED`/`BLOCKED`
occurrence-keyed rules mirroring scenarios 2a/2b/2c, using the existing
`FakeScenarioResolver` mechanism (`execution/infrastructure/runners/fake-
scenarios.ts`) already wired through `config.yaml`'s `fake-worker`/
`fake-reviewer` runners. This is a manual walkthrough against the real
`atolis-hq/wake-test` repo to visually confirm labels/comments land correctly
end-to-end — it complements, not replaces, the deterministic suite.

## Out of scope / explicit non-changes

- No change to `reconcileChildCompletions` or any propagation of a blocked
  child's status to its parent. Confirmed as correct existing behaviour, not a
  gap: a parent watching for a review's `child-completed` signal legitimately
  has nothing to react to until a verdict exists.
- No forcing of a terminal verdict on a watch child's exhausted technical
  retries. `blocked` and `rejected` stay semantically distinct.
