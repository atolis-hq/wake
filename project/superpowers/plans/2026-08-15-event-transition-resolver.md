# Event Transition Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple generic workflow advancement from V1 primary-PR event-transition matching.

**Architecture:** A resolver port returns the earliest eligible event-transition evidence and configured target for a waiting workflow. `AdvanceWorkflow` applies that generic result; a primary-PR implementation owns PR correlation, trust, freshness, state, and payload matching.

**Tech Stack:** TypeScript, Zod, Vitest, Wake event journal and projections.

---

### Task 1: Specify resolver behavior with a failing E2E test

**Files:**
- Modify: `test/e2e/scenarios/event-transitions.test.ts`

- [ ] **Step 1: Write the failing test**

Add a scenario where `pr.state-changed { state: closed }` precedes `pr.state-changed { state: merged }` and a `{ state: merged }` transition. Assert that the accepted-signal evidence is the merged event, not the closed event.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/e2e/scenarios/event-transitions.test.ts`

Expected: FAIL because the resolver either records the wrong evidence or is not yet independently testable.

- [ ] **Step 3: Commit**

```powershell
git add test/e2e/scenarios/event-transitions.test.ts
git commit -m "test: cover event transition evidence matching"
```

### Task 2: Extract the event-transition resolver

**Files:**
- Create: `src/orchestration/application/event-transition-resolver.ts`
- Modify: `src/orchestration/application/advance-workflow.ts`
- Modify: `src/orchestration/application/orchestration-service.ts`
- Modify: `src/orchestration/index.ts`
- Modify: `src/bootstrap/composition-root.ts`
- Modify: `test/e2e/support/world.ts`

- [ ] **Step 1: Write the resolver port and primary-PR implementation**

Define a resolver result with `evidenceId`, `position`, and `target`; define a port that accepts a waiting workflow and optional exclusive upper position. Implement the primary-PR resolver using `PullRequestService.authorityInput` and the event journal. It must return no result without exactly one non-conflicted primary PR, and it must validate each event payload against its compiled `where` predicate.

- [ ] **Step 2: Make advancement consume only the port**

Replace PR-specific imports and matching helpers in `AdvanceWorkflow` with a resolver call. Preserve the existing signal acceptance and optimistic append behavior. Pass a watch verdict's journal position as the exclusive upper bound, so an earlier resolver result wins.

- [ ] **Step 3: Wire production and test composition**

Construct the primary-PR resolver at the composition root and pass it through the orchestration service into `AdvanceWorkflow`. Wire the same production resolver in `TestWorld`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run test/e2e/scenarios/event-transitions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/orchestration src/bootstrap/composition-root.ts test/e2e/support/world.ts test/e2e/scenarios/event-transitions.test.ts
git commit -m "refactor: isolate event transition resolution"
```

### Task 3: Verify the closed vocabulary and regression suite

**Files:**
- Modify only if required by failed checks: `src/orchestration/contracts/event-decoder.ts`
- Test: `test/unit/orchestration/compiled-contracts.test.ts`

- [ ] **Step 1: Run architecture and focused contract checks**

Run: `npm run lint:architecture; npx vitest run test/unit/orchestration/compiled-contracts.test.ts`

Expected: both commands PASS, including use of `PullRequestState` and `PullRequestCheckState` rather than literal predicate values.

- [ ] **Step 2: Run the relevant E2E suite**

Run: `npm run test:e2e -- --run test/e2e/scenarios/event-transitions.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit verification fixes if needed**

```powershell
git add src/orchestration/contracts/event-decoder.ts test/unit/orchestration/compiled-contracts.test.ts
git commit -m "fix: validate event transition vocabulary"
```
