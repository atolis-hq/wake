# Workspace Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a work item's workspace available across activities and remove it only after the work item is terminal or deleted.

**Architecture:** A workspace lease ends only the activity's use of a workspace; it no longer deletes the workspace. The control-plane recovery pass owns physical disposal, retaining a marked workspace while its WorkItem is open and deleting it after terminal/deleted state once no run still needs it.

**Tech Stack:** TypeScript, Vitest, file-backed Git workspaces, event-sourced Work views.

---

### Task 1: Preserve a workspace after an activity lease ends

**Files:**
- Modify: `test/unit/execution/git-workspace.test.ts`
- Modify: `src/execution/infrastructure/workspace/git-workspace.ts`

- [ ] **Step 1: Write the failing test**

Add a branch-workspace test that acquires a lease, calls `release()`, and asserts that the workspace and ownership marker still exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/execution/git-workspace.test.ts`

Expected: FAIL because `release()` removes the workspace.

- [ ] **Step 3: Write minimal implementation**

Make `WorkspaceLease.release()` relinquish only the activity lease. Keep branch workspace data and its ownership marker. On later acquisition of the same workspace, check out the deterministic WorkItem branch rather than attempting to create it again.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/execution/git-workspace.test.ts`

Expected: PASS.

### Task 2: Dispose retained workspaces only after WorkItem terminal state

**Files:**
- Modify: `test/integration/execution/workspace-recovery.test.ts`
- Modify: `src/execution/contracts/workspace.ts`
- Modify: `src/execution/infrastructure/workspace/git-workspace.ts`
- Modify: `src/control-plane/application/advance-once.ts`
- Modify: `src/bootstrap/composition-root.ts`

- [ ] **Step 1: Write the failing tests**

Add recovery cases proving an open WorkItem retains a terminal run's workspace and a closed, cancelled, or deleted WorkItem reclaims it. Keep active and ambiguous runs protected regardless of lifecycle state.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/execution/workspace-recovery.test.ts`

Expected: FAIL because recovery currently removes terminal-run workspaces without WorkItem state.

- [ ] **Step 3: Write minimal implementation**

Extend workspace recovery options with an asynchronous WorkItem-retention predicate. Have the control plane supply `true` only for a non-deleted open WorkItem. Reclaim an owned workspace only when no run is active or ambiguous and the predicate says it is no longer retained.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/execution/workspace-recovery.test.ts test/unit/execution/git-workspace.test.ts`

Expected: PASS.

### Task 3: Verify composed lifecycle and build

**Files:**
- Test: `test/unit/control-plane/advance-once.test.ts` (if a focused composition assertion is needed)

- [ ] **Step 1: Run focused execution and control-plane tests**

Run: `npx vitest run test/unit/execution/git-workspace.test.ts test/integration/execution/workspace-recovery.test.ts test/unit/control-plane/advance-once.test.ts`

Expected: PASS.

- [ ] **Step 2: Run type/build verification**

Run: `npm run build`

Expected: PASS.
