# Runner controls implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Task 25B step 13 with durable runner pause commands, truthful status, and composed fallback proof.

**Architecture:** Control Plane owns pause events and projection state. Bootstrap exposes narrow command applications and derives runner status from that projection; surfaces only route and render those applications.

**Tech Stack:** TypeScript, Zod, Vitest, Wake event journal/projections, API and web surfaces.

---

### Task 1: Runner command contract and applications

**Files:** Modify `src-next/surfaces/api/routes/{applications,commands,execution}.ts`, `src-next/bootstrap/surface-api-applications.ts`; test `test-next/surfaces/api-routes.test.ts`.

- [ ] Write failing API tests for `POST /runners/:id/commands/pause` and `unpause`, including duplicate idempotency keys and unknown runners.
- [ ] Run `npx vitest run --config vitest.next.config.ts test-next/surfaces/api-routes.test.ts`; confirm failure because pause is not a runner route and unpause is unavailable.
- [x] Implement both routes and narrow bootstrap applications that append `RunnerPaused(manual, "paused by operator")` and `RunnerResumed` to the control stream.
- [x] Re-run the focused route test; confirm pass.

### Task 2: Truthful runner status and web controls

**Files:** Modify `src-next/bootstrap/surface-api-applications.ts`, `src-next/surfaces/web/src/{api/client.ts,features/health/health.tsx}`; test the matching API and web health tests.

- [ ] Write failing tests for a paused runner reporting `paused`/`available: false` and for health displaying Pause or Unpause from that value.
- [ ] Run the focused target and web tests; confirm failures due to synthesized always-available status and no command client/action.
- [x] Derive status/detail from the control projection and clock; add client methods and button actions with fresh idempotency keys.
- [x] Re-run focused tests; confirm pass.

### Task 3: Composed durability and fallback proof

**Files:** Create/modify `test-next/e2e/scenarios/runner-pause-fallback.test.ts` and fixture helpers as needed.

- [ ] Write a failing composed scenario using `[sonnet, codex-mini]`: quota pause selects `codex-mini`, replay/restart preserves it, expiry restores `sonnet`, and explicit unpause restores `sonnet` early.
- [ ] Run the scenario; confirm failure before any test-only shortcuts.
- [ ] Complete only production composition seams required by the scenario, including command idempotency under journal append contention.
- [x] Re-run the scenario and focused suites; confirm pass.

### Task 4: Close the packet

**Files:** Modify `docs/superpowers/plans/2026-08-01-wake-task-25a-live-runtime-parity.md`.

- [x] Update Step 13 from In progress to Built with exact evidence and mark the final remediation plan items complete.
- [x] Run `npm run lint:contracts`, `npm run lint:architecture`, `npm run knip:next`, `npm run verify:next`, and `npm run verify`.
- [x] Commit all remaining Step 13 work once every gate passes.
