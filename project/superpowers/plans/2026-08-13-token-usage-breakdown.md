# Token Usage Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show provider-aware token totals and input, output, cache-read, and cache-write breakdowns in Wake's operational UI.

**Architecture:** Keep runner result metadata and execution events unchanged. Add a presentation-level usage summary which retains every stored counter, calculates a provider-aware total, and is used by the run presenter and board projection. Expose the summary through API contracts and render it in compact, keyboard-accessible UI details.

**Tech Stack:** TypeScript, Vitest, React, CSS modules.

---

### Task 1: Define and test usage summaries

**Files:**
- Modify: `src/execution/contracts/runner.ts`
- Test: `test/unit/execution/runner.test.ts`

- [ ] Write failing tests for a summary which preserves every metadata counter and counts Claude cache writes without double-counting cache reads.
- [ ] Implement the smallest typed summary helper alongside `agentTokenUsage`.
- [ ] Run `npx vitest run test/unit/execution/runner.test.ts`.

### Task 2: Expose and aggregate the summary

**Files:**
- Modify: `src/surfaces/api/contracts/execution.ts`
- Modify: `src/surfaces/api/contracts/board.ts`
- Modify: `src/surfaces/api/presenters/execution.ts`
- Modify: `src/bootstrap/board-projection.ts`
- Test: `test/unit/bootstrap/board-projection.test.ts`
- Test: `test/integration/surfaces/board-api.test.ts`

- [ ] Write failing projection and presenter/API tests for the category values and provider-aware total.
- [ ] Aggregate the stored counters on cards and expose them on individual runs and board cards.
- [ ] Run the focused projection and surface tests.

### Task 3: Render accessible in-situ usage details

**Files:**
- Create: `src/surfaces/web/src/components/token-usage.tsx`
- Modify: `src/surfaces/web/src/features/runs/runs.tsx`
- Modify: `src/surfaces/web/src/features/work/work.tsx`
- Modify: `src/surfaces/web/src/features/board/board-card.tsx`
- Test: `src/surfaces/web/test/runs.test.tsx`
- Test: `src/surfaces/web/test/work-detail.test.tsx`
- Test: `src/surfaces/web/test/board.test.tsx`

- [ ] Write failing component tests for the displayed total and accessible breakdown text.
- [ ] Implement a shared usage component using a native focusable details disclosure so hover/focus has an in-situ explanation.
- [ ] Run the focused web tests and `npm run build:web`.

### Task 4: Verify

**Files:**
- Verify only

- [ ] Run `npm run test:fast`, `npm run test:web`, and `npm run build`.
- [ ] Review `git diff --check` and `git status --short`.
