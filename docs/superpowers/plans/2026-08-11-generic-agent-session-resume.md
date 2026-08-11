# Generic Agent Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a prior opaque vendor session on a retry of the same agent
activation, with current full context and a safe adapter-local fresh-session
fallback.

**Architecture:** Execution derives a generic resume candidate from its
journal-folded prior Runs for the current activation, matching the selected
runner adapter kind. Agent Activity forwards that opaque value in its existing
runner request after rendering the current prompt. Concrete runner adapters
own resume argv, minimal output parsing, and the sole known-unavailable
fallback; they return only generic session and token values.

**Tech Stack:** TypeScript, existing Execution journal/Run projection, runner
adapters, Vitest.

---

## File map

- `src-next/activities/contracts/activity.ts` — allow the generic runner port
  and activity execution context to carry an optional opaque resume ID.
- `src-next/activities/agent/agent-activity.ts` — build the usual complete
  request, then forward that optional ID without interpretation.
- `src-next/execution/application/execution-service.ts` — select a safe prior
  session from `RunRepository.list(activationId)` after resolving the runner.
- `src-next/execution/contracts/runner.ts` — retain the generic request/result
  vocabulary; add only a small shared adapter helper type if duplication would
  otherwise leak policy.
- `src-next/execution/infrastructure/runners/{claude,codex,cursor}.ts` — own
  vendor argv, private result parsing, and known-unavailable resume fallback.
- `src-next/execution/infrastructure/runners/{claude,codex,cursor}.spec.md`
  (or the shared `runners.spec.md`) — describe the completed adapter contract.
- `test-next/unit/execution/runner-selection.test.ts` — prove durable
  candidate selection and scope boundaries.
- `test-next/unit/activities/agent-activity.test.ts` — prove forwarding after
  full prompt/template context is constructed.
- `test-next/integration/execution/process-execution.test.ts` — prove precise
  CLI argv and generic parsing/fallback behaviour using controlled processes.

### Task 1: Carry the opaque resume candidate through Execution

**Files:** Modify `src-next/activities/contracts/activity.ts`,
`src-next/activities/agent/agent-activity.ts`,
`src-next/execution/application/execution-service.ts`; test
`test-next/unit/execution/runner-selection.test.ts` and
`test-next/unit/activities/agent-activity.test.ts`.

- [ ] **Step 1: Write failing scope tests.** Add two attempts for one
  activation: make the first runner report `{ sessionId: 's-1' }`, then assert
  the second selected runner receives `resumeSessionId: 's-1'`. Add controls
  where the first Run has a different `runner.cli`, no ID, or belongs to a
  different activation; assert the new request omits the field.

- [ ] **Step 2: Run the focused test and verify it fails.**

  Run: `npx vitest run test-next/unit/execution/runner-selection.test.ts`

  Expected: the second request has no `resumeSessionId` because Execution
  currently records but never selects durable sessions.

- [ ] **Step 3: Write a failing Agent Activity forwarding test.** Use a
  template renderer and context reader, supply `resumeSessionId: 's-1'` on
  `ActivityExecutionContext`, and assert the runner receives both `s-1` and
  the fully rendered prompt including `<wake-untrusted-data>`.

- [ ] **Step 4: Implement the minimal generic hand-off.** Add optional
  `resumeSessionId` to `AgentRunnerPort.start` and `ActivityExecutionContext`.
  In `attemptExecution`, after resolving the current agent runner, inspect
  `prior` newest-first. Select only a Run whose `runner.cli` equals the
  resolved runner's `cli` and whose `agent.metadata.sessionId` is a non-empty
  string. Pass it into `executeActivity`; Agent Activity copies it unchanged
  into `requestFrom`. Do not inspect the string format or add it to public
  workflow input.

- [ ] **Step 5: Rerun focused unit tests.**

  Run: `npx vitest run test-next/unit/execution/runner-selection.test.ts test-next/unit/activities/agent-activity.test.ts`

  Expected: PASS; same-activation/same-adapter is the only resumed case.

- [ ] **Step 6: Commit.**

  ```bash
  git add src-next/activities/contracts/activity.ts src-next/activities/agent/agent-activity.ts src-next/execution/application/execution-service.ts test-next/unit/execution/runner-selection.test.ts test-next/unit/activities/agent-activity.test.ts
  git commit -m "feat: resume durable agent sessions"
  ```

### Task 2: Implement vendor-local resume and generic result extraction

**Files:** Modify `src-next/execution/infrastructure/runners/claude.ts`,
`src-next/execution/infrastructure/runners/codex.ts`, and
`src-next/execution/infrastructure/runners/cursor.ts`; test
`test-next/integration/execution/process-execution.test.ts`.

- [ ] **Step 1: Write table-driven failing adapter tests.** For every vendor,
  assert its existing resume argv convention gets the same full `prompt` as a
  fresh invocation. Feed each adapter a controlled successful vendor-shaped
  output and assert only `{ output, sessionId, tokenUsage }` crosses the
  adapter boundary. Keep raw response fixtures inside this test.

- [ ] **Step 2: Run the focused integration test and verify it fails.**

  Run: `npx vitest run test-next/integration/execution/process-execution.test.ts`

  Expected: Claude/Cursor omit resume argv and all production adapters return
  unparsed stdout with no session/token fields.

- [ ] **Step 3: Implement private parser functions.** Give each adapter a
  local parser which accepts only its documented successful output shape,
  extracts the final agent text, opaque session ID, and numeric token/cost
  counters, and returns the existing `AgentRunnerResult` fields. Preserve
  plain-output compatibility when a successful output is not that vendor's
  structured form; never put the parsed raw object into metadata. Build argv
  from the existing legacy-tested shapes: Claude `--resume <id>`, Codex `exec
  ... resume <id> <prompt>`, and Cursor `--resume=<id>`; retain the full prompt
  in each shape.

- [ ] **Step 4: Rerun the adapter tests.**

  Run: `npx vitest run test-next/integration/execution/process-execution.test.ts`

  Expected: PASS; tests observe generic values only outside the adapter.

- [ ] **Step 5: Commit.**

  ```bash
  git add src-next/execution/infrastructure/runners/claude.ts src-next/execution/infrastructure/runners/codex.ts src-next/execution/infrastructure/runners/cursor.ts test-next/integration/execution/process-execution.test.ts
  git commit -m "feat: add vendor session resume adapters"
  ```

### Task 3: Safely fall back when a session is known unavailable

**Files:** Modify `src-next/execution/infrastructure/runners/{claude,codex,cursor}.ts`; test `test-next/integration/execution/process-execution.test.ts`.

- [ ] **Step 1: Write failing per-adapter fallback tests.** Script each
  adapter's process seam so a resume produces its explicitly recognised
  unavailable-session response and a fresh invocation succeeds. Assert two
  invocations only: resume with the ID then fresh without it, both with the
  identical full prompt. Add timeout, cancellation, and arbitrary non-zero
  controls asserting exactly one invocation and the original failure.

- [ ] **Step 2: Run the focused test and verify it fails.**

  Run: `npx vitest run test-next/integration/execution/process-execution.test.ts`

  Expected: current CLI runner returns the first process failure and performs
  no constrained fresh fallback.

- [ ] **Step 3: Implement the bounded local policy.** Make each adapter's
  private classifier recognise only its explicit invalid/expired/unsupported
  session response. On that classification, invoke its normal fresh command
  once with the original complete `RunnerRequest` but no `resumeSessionId`.
  Do not fall back for timeout, abort, ambiguous state, quota, or an unknown
  non-zero result. Return the fresh result normally so its newly parsed ID is
  durably recorded by the unchanged reporting path.

- [ ] **Step 4: Rerun the fallback proof.**

  Run: `npx vitest run test-next/integration/execution/process-execution.test.ts`

  Expected: PASS; every safe fallback is bounded and every uncertain failure
  remains non-replayed.

- [ ] **Step 5: Commit.**

  ```bash
  git add src-next/execution/infrastructure/runners/claude.ts src-next/execution/infrastructure/runners/codex.ts src-next/execution/infrastructure/runners/cursor.ts test-next/integration/execution/process-execution.test.ts
  git commit -m "fix: fall back from unavailable agent sessions"
  ```

### Task 4: Specify and verify the complete contract

**Files:** Modify `src-next/activities/agent/agent-activity.spec.md`,
`src-next/execution/application/execution-service.spec.md`, and
`src-next/execution/infrastructure/runners/runners.spec.md`; test relevant
unit/integration suites.

- [ ] **Step 1: Update the three specifications.** State activation plus
  adapter-kind scope, opaque cross-layer ID, current prompt forwarding,
  adapter-private parsing, one known-unavailable fallback, and the explicit
  no-replay failure boundary. Correct the current runners specification's
  stale claim that only Codex reads `resumeSessionId` and no adapter populates
  session/token usage.

- [ ] **Step 2: Run focused and repository gates.**

  Run: `npx vitest run test-next/unit/execution/runner-selection.test.ts test-next/unit/activities/agent-activity.test.ts test-next/integration/execution/process-execution.test.ts`

  Expected: PASS.

  Run: `npm run check:specs && npm run lint:architecture && npm run verify:next`

  Expected: all checks pass.

- [ ] **Step 3: Commit documentation and verification.**

  ```bash
  git add src-next/activities/agent/agent-activity.spec.md src-next/execution/application/execution-service.spec.md src-next/execution/infrastructure/runners/runners.spec.md
  git commit -m "docs: specify durable agent session resume"
  ```

## Review checkpoints

After every task, use a fresh implementation reviewer to check the task
against this plan, then a code-quality reviewer to check type boundaries,
durability, no vendor leakage, failure replay safety, and test quality. Fix
all findings before the next task. Do not edit the functional catalogue or
the granular audit until the final implementation evidence exists.
