# Safe Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely quiesce Wake before source-mode self-update, recover from interruption, and preserve loop retry semantics for newly published tags.

**Architecture:** Bootstrap persists a maintenance lease beside the update ledger. Control Plane blocks dispatch while the lease is active; Bootstrap drains, requests cancellation, then invokes checkout/rollout/rollback. The loop keeps polling after failures but skips ledger-recorded bad tags.

**Tech Stack:** Node.js, TypeScript, Zod, Vitest, atomic JSON state, append-only journal/projections.

---

## Task 1: Persist maintenance state

**Files:** Create `src-next/bootstrap/update-maintenance-lease.ts` and `test-next/integration/bootstrap/update-maintenance-lease.test.ts`; modify `src-next/bootstrap/index.ts`.

- [ ] Write failing tests for atomic acquire/read/transition/fail/clear. A second acquire must return the original `attemptId` and tag.
- [ ] Run `npx vitest run --config vitest.next.integration.config.ts test-next/integration/bootstrap/update-maintenance-lease.test.ts`; expect missing module failure.
- [ ] Implement `.wake/update-maintenance.json` with attempt ID, tag, phase (`quiescing`, `updating`, `rolling-back`, `failed`), timestamp, and optional failure.
- [ ] Rerun the test, then commit `feat: persist self update maintenance lease`.

## Task 2: Quiesce active work

**Files:** Modify `src-next/bootstrap/self-update-application.ts`, `src-next/bootstrap/config/root-schema.ts`, and `test-next/unit/bootstrap/self-update-application.test.ts`.

- [ ] Write failing tests for immediate drain, grace expiry then durable cancellation, and refusal to checkout when a cancellation remains unconfirmed.
- [ ] Run `npx vitest run --config vitest.next.unit.config.ts test-next/unit/bootstrap/self-update-application.test.ts`; expect checkout without quiescing.
- [ ] Add positive `host.selfUpdate.drainTimeoutMs` and `cancellationTimeoutMs`. Inject a quiesce port that blocks dispatch, polls active Runs, requests maintenance cancellation, and fails the lease without checkout if a Run remains.
- [ ] Rerun the test, then commit `feat: quiesce runs before self update`.

## Task 3: Compose maintenance and dispatch blocking

**Files:** Modify `src-next/bootstrap/composition-root.ts`, `src-next/bootstrap/surface-cli-applications.ts`, `src-next/control-plane/application/advance-once.ts`; create `test-next/e2e/scenarios/self-update-maintenance.test.ts`.

- [ ] Write failing composed scenarios: no new Run dispatch while quiescing; completing Run drains without cancellation; slow Run is durably cancelled; checkout waits for empty active views.
- [ ] Run the new E2E; expect dispatch still permitted.
- [ ] Compose lease, active-run lookup, cancellation, clock, and timeouts. `advanceOnce` must not dispatch during `quiescing`, `updating`, or `rolling-back`; intake, projections, recovery, and delivery reconciliation continue.
- [ ] Rerun the E2E and `npm run lint:architecture`, then commit `feat: maintain safe self update quiesce`.

## Task 4: Recover and continue loop on new tags

**Files:** Modify `src-next/bootstrap/self-update-application.ts`, `src-next/bootstrap/surface-cli-applications.ts`, `src-next/surfaces/cli/commands/self-update.ts`, corresponding unit/integration tests, and `self-update-maintenance.test.ts`.

- [ ] Write failing tests for restart in every lease phase, failed-health rollback, no duplicate runner/provider effect, and candidates `v2` fails → `v2` skips → `v3` applies.
- [ ] Run `npx vitest run --config vitest.next.integration.config.ts test-next/integration/surfaces/self-update.test.ts`; expect absent candidate-selection proof.
- [ ] Resume each stored phase idempotently. Record failures as bad, keep looping after the wait boundary, skip bad tags unless forced, and clear maintenance only after healthy completion.
- [ ] Rerun focused tests, then commit `feat: recover safe self update loop`.

## Task 5: Document and verify

**Files:** Modify `src-next/bootstrap/SPEC.md`, `src-next/bootstrap/self-update.spec.md`, `docs/architecture/functional-decision-catalogue.md`, and `docs/reports/2026-08-10-granular-legacy-target-review.md`.

- [ ] Document maintenance phases, cancellation, dispatch blocking, recovery, and loop semantics; mark G-M6 directly proven.
- [ ] Run `npm run check:catalogue`, `npm run check:scenarios`, `npm run lint:architecture`, `npm run knip:next`, `npm run verify:next`, `npm run verify`, and `npm run check:specs`; all must pass.
- [ ] Commit `docs: specify safe self update maintenance`.
