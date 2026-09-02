# Runtime Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover legacy orchestration projections safely and prevent scheduler lock contention from consuming CPU or delaying dispatch.

**Architecture:** Keep the journal authoritative and make projection compatibility local to Orchestration. Bound the scheduler transaction at durable dispatch, move long execution outside it, add non-spinning filesystem contention handling, and surface runtime errors through the API.

**Tech Stack:** TypeScript, Eventing processors, filesystem adapters, Vitest.

---

### Task 1: Orchestration projection compatibility

**Files:**
- Modify: `src/orchestration/application/orchestration-projection.ts`
- Modify: `src/orchestration/domain/workflow-instance.ts`
- Test: `test/unit/orchestration/orchestration-projection.test.ts`

- [ ] Add a failing regression proving the canonical projection stores only the folded workflow view.
- [ ] Verify the test fails while the projection still stores decoded event history.
- [ ] Add a domain single-event continuation operation and change the canonical projection value to current folded state without a legacy union or upcaster.
- [ ] Update every projection reader and scenario fixture to consume the canonical value directly.
- [ ] Verify focused orchestration projection, API, E2E, and rebuild-command tests pass.

### Task 2: Bound scheduler execution lifetime

**Files:**
- Modify: `src/control-plane/application/advance-once-dispatch.ts`
- Modify as required: `src/execution/application/execution-service.ts`
- Test: `test/unit/control-plane/activation-scheduler.test.ts`
- Test as required: `test/unit/execution/execution-service.test.ts`

- [ ] Add a failing test proving scheduler dispatch resolves after durable run preparation while the runner remains pending.
- [ ] Verify it hangs or observes immediate-completion behavior before the fix.
- [ ] Stop requesting `awaitImmediateCompletion` from the subscription-driven scheduler and preserve later execution/outcome reconciliation.
- [ ] Verify focused control-plane and execution tests pass.

### Task 3: Back off contended processor locks

**Files:**
- Modify: `packages/eventing-filesystem/src/file-processor-run-serialiser.ts`
- Test: `packages/eventing-filesystem/test/file-processor-run-serialiser.test.ts`

- [ ] Add a deterministic failing test that records retry delays during contention.
- [ ] Verify the current implementation repeatedly requests 10 ms waits.
- [ ] Implement bounded exponential contention backoff with prompt abort handling and reset per acquisition.
- [ ] Verify the filesystem package tests pass.

### Task 4: Expose processor failures

**Files:**
- Modify: `src/bootstrap/surface-api-applications.ts`
- Modify if required: `src/surfaces/api/routes/applications.ts`
- Test: `test/unit/bootstrap/surface-api-system-applications.test.ts`

- [ ] Add a failing API test for bounded `lastError` detail on a degraded processor.
- [ ] Verify the response currently omits the error.
- [ ] Include the existing Eventing health error in the public health detail without leaking stack traces.
- [ ] Verify focused API tests pass.

### Task 5: Integrated verification

**Files:**
- Modify current-state docs only if public health output changed.

- [ ] Run all focused tests from Tasks 1-4.
- [ ] Run `npm run test:architecture`.
- [ ] Run `npm run verify`.
- [ ] Review the complete diff for compatibility, lock lifetime, and unrelated changes.
- [ ] Commit and push the fixes to PR #790.
