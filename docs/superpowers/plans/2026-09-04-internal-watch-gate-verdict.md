# Internal Watch-Gate Verdict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a watch-gated parent directly from its completed child's durable outcome.

**Architecture:** `RequestChild` already reconciles child completions and owns the parent-facing synthetic signal. It will select the existing child-completion signal for explicit waits, or the existing watch-gate-verdict signal—with the child's `done` or `rejected` outcome—for a watch-gated parent. GitHub delivery remains outside this control path.

**Tech Stack:** TypeScript, Vitest, Wake event journal and orchestration E2E harness.

---

### Task 1: Prove rejected review completion re-enters implement internally

**Files:**
- Modify: `test/e2e/scenarios/watch-gate-verdict-round-trip.test.ts`
- Modify: `src/orchestration/application/request-child.ts`

- [ ] **Step 1: Write the failing scenario**

Add a scenario with an `implement` activity that returns `done` and a watch-gated `pr-review` child whose review activity returns `rejected`. Advance the world through child completion without appending a GitHub comment. Assert the primary's pending activation is a second `implement` activation and its accepted signal is `orchestration.watch-gate-verdict` with `outcome: 'rejected'`.

- [ ] **Step 2: Run the focused scenario to verify it fails**

Run: `npx vitest run test/e2e/scenarios/watch-gate-verdict-round-trip.test.ts`

Expected: FAIL because child reconciliation produces `orchestration.child-completed`, which the parent watch-gate wait ignores.

- [ ] **Step 3: Implement direct verdict synthesis**

In `RequestChild.complete`, inspect the parent wait. When it expects `WatchGateVerdictSignal`, construct that signal with the child's watch authority, workflow-instance evidence, and a `done` or `rejected` outcome read from `child.lastOutcome`. Otherwise retain the existing `orchestration.child-completed` signal construction. Do not make any GitHub calls or inspect published reports.

- [ ] **Step 4: Run the focused scenario to verify it passes**

Run: `npx vitest run test/e2e/scenarios/watch-gate-verdict-round-trip.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
```text
git add src/orchestration/application/request-child.ts test/e2e/scenarios/watch-gate-verdict-round-trip.test.ts docs/superpowers/specs/2026-09-04-internal-watch-gate-verdict-design.md docs/superpowers/plans/2026-09-04-internal-watch-gate-verdict.md
git commit -m "fix: consume watch verdicts from child outcomes"
```

### Task 2: Verify the orchestration surface

**Files:**
- Test: `test/e2e/scenarios/watch-gate-verdict-round-trip.test.ts`
- Test: `test/e2e/scenarios/child-completion.test.ts`

- [ ] **Step 1: Run direct child-completion coverage**

Run: `npx vitest run test/e2e/scenarios/child-completion.test.ts test/e2e/scenarios/watch-gate-verdict-round-trip.test.ts`

Expected: PASS, proving ordinary child-completion waits retain their existing behavior while watch gates use the internal verdict path.

- [ ] **Step 2: Run the fast verification gate**

Run: `npm run verify`

Expected: exit code 0.
