# Workspace crash recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim only safely identified Git workspaces left by a crashed
Execution attempt, preserving active and ambiguous work.

**Architecture:** Git workspace acquisition creates a durable ownership marker
outside the workspace directory before cloning. Execution includes the Run ID
in the workspace request. Startup/recovery reads markers plus journal-folded
Run views and removes only terminal or never-started owners. It retains
Started, Ambiguous, unknown, malformed, and out-of-root paths.

**Tech Stack:** TypeScript, Node `fs/promises`, existing `WorkspaceProvider`,
Execution Run views, composition root, Vitest.

---

### Task 1: Persist workspace ownership

**Files:** Modify `src-next/execution/contracts/workspace.ts`,
`src-next/execution/infrastructure/workspace/git-workspace.ts`,
`src-next/execution/application/execution-service.ts`; test
`test-next/unit/execution/git-workspace.test.ts`.

- [ ] Write failing tests which acquire a Git workspace with a Run ID and
  assert an ownership record exists before clone; assert `release()` removes
  both the workspace and its ownership record.
- [ ] Run the focused workspace test and observe the missing-marker failure.
- [ ] Add `runId` to `WorkspaceRequest`; have `attemptExecution` supply its
  already-created Run ID. Store a strict JSON ownership record under a
  managed marker directory beneath the workspace root before invoking git.
  Include `runId`, `workItemId`, repository resource ID, mode, workspace ID,
  and absolute path. Make release idempotently remove the workspace then its
  marker.
- [ ] Rerun the focused test and commit the ownership change.

### Task 2: Reclaim safe crash orphans

**Files:** Modify `src-next/execution/contracts/workspace.ts`,
`src-next/execution/infrastructure/workspace/git-workspace.ts`,
`src-next/execution/application/execution-service.ts`; test
`test-next/integration/execution/workspace-recovery.test.ts`.

- [ ] Write failing integration cases for a terminal owned workspace, a
  marker whose Run never started, a Started workspace, an Ambiguous workspace,
  an unknown directory, malformed marker data, and a marker path outside the
  managed root.
- [ ] Run the test and observe that no recovery API exists.
- [ ] Add an optional workspace recovery capability which receives
  journal-backed Run views. It must delete only a marker-owned path under the
  managed root when the matching Run is terminal or absent. It must retain
  Started/Ambiguous/unknown/malformed entries and continue after a deletion
  error. Repeat calls must be idempotent.
- [ ] Rerun the integration test and commit the safe recovery implementation.

### Task 3: Compose startup recovery

**Files:** Modify `src-next/bootstrap/composition-root.ts` and
`src-next/control-plane/application/advance-once.ts`; test
`test-next/e2e/scenarios/workspace-crash-recovery.test.ts`.

- [ ] Write a composed restart scenario: persist an ownership marker before
  `RunStarted`, create the matching on-disk workspace, compose a fresh root,
  advance recovery, and assert the orphan is removed. Add Started/Ambiguous
  controls asserting they remain.
- [ ] Run the new scenario and observe recovery is not composed.
- [ ] Wire the existing recovery pass to invoke workspace recovery before new
  dispatch. Preserve the full-maintenance pause boundary: maintenance prevents
  this tick-driven deletion. Do not create a resident reaper or an age-based
  timer.
- [ ] Rerun the scenario and architecture lint, then commit composition.

### Task 4: Document and verify

**Files:** Update `src-next/execution/SPEC.md`,
`src-next/execution/infrastructure/workspace/workspace.spec.md`,
`docs/architecture/functional-decision-catalogue.md`, and
`docs/reports/2026-08-10-granular-legacy-target-review.md`.

- [ ] Document marker ownership, safe deletion conditions, retained unknown
  paths, and no-config policy. Mark G-M5 directly proven only when composed
  crash recovery evidence exists.
- [ ] Run `npm run check:catalogue`, `npm run check:scenarios`,
  `npm run check:specs`, `npm run lint:architecture`, `npm run verify:next`,
  and `npm run verify`.
- [ ] Commit the specification and verification update.
