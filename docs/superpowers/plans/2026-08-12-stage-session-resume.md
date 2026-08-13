# Primary Stage Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a primary workflow stage's latest compatible CLI session when that stage is re-entered, while keeping watch workflow runs fresh.

**Architecture:** Orchestration already distinguishes primary workflow instances from watch-child instances. It will pass a session policy to Execution. Execution will use that policy to select terminal Run sessions by primary workflow instance and stage, filtering by runner CLI; watch activations pass `fresh` and skip lookup.

**Tech Stack:** TypeScript, Zod contracts, Vitest.

---

### Task 1: Express activation session policy

**Files:**
- Modify: `src/activities/contracts/commands.ts`
- Modify: `src/orchestration/contracts/views.ts`
- Test: `test/unit/execution/runner-selection.test.ts`

- [ ] Add a `sessionPolicy: 'fresh' | 'resume-stage'` field to the execution request created from orchestration context.
- [ ] Ensure primary stage activations select `resume-stage`; watch-child workflow activations select `fresh`.
- [ ] Add a focused test proving a watch workflow request remains fresh.

### Task 2: Resume the primary stage across activation IDs

**Files:**
- Modify: `src/execution/application/execution-service.ts`
- Test: `test/unit/execution/runner-selection.test.ts`

- [ ] Write a failing test with two terminal primary `implement` Runs that have different activation IDs and the same workflow instance; assert the newest same-CLI session is forwarded.
- [ ] Run `npx vitest run --config vitest.unit.config.ts test/unit/execution/runner-selection.test.ts` and verify the new assertion fails.
- [ ] Extend session lookup to inspect all terminal Runs only for `resume-stage`, matching workflow instance, stage, and CLI.
- [ ] Re-run the focused test and verify it passes.

### Task 3: Protect fresh watch sessions and CLI fallback

**Files:**
- Modify: `test/unit/execution/runner-selection.test.ts`

- [ ] Add a failing test that a fresh watch activation never forwards a matching historic session.
- [ ] Add a failing test that a primary stage ignores a prior session recorded by a different CLI.
- [ ] Run the focused test and verify both failures.
- [ ] Implement the minimal policy plumbing needed for the tests.
- [ ] Re-run the focused test and verify it passes.

### Task 4: Verify the execution boundary

**Files:**
- Modify: `src/execution/application/execution-service.spec.md`

- [ ] Update the execution component specification to describe primary-stage session continuity and fresh watch sessions.
- [ ] Run `npx vitest run --config vitest.unit.config.ts test/unit/execution/runner-selection.test.ts`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:fast`.
