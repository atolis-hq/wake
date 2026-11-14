# Runner Legacy Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the proven legacy non-interactive runner behavior so Wake invokes Codex, Claude, and Cursor with their configured execution settings and never leaves a CLI waiting on stdin.

**Architecture:** Preserve the current runner abstraction, but carry the resolved runner configuration into each concrete adapter as defaults. Prompt-template values remain explicit overrides. The shared process boundary owns stdin closure; each adapter owns only its vendor-specific command arguments.

**Tech Stack:** TypeScript, Node child_process, Vitest, Codex CLI, Claude CLI, Cursor CLI.

---

### Task 1: Close CLI stdin at the shared process boundary

**Files:**
- Modify: `src/execution/infrastructure/process-execution.ts`
- Test: `test/unit/execution/process-execution.test.ts`

- [ ] **Step 1: Write the failing test**

Add a fake child-process test asserting the spawned stdio is `['ignore', 'pipe', 'pipe']`, preserving captured stdout/stderr while supplying immediate EOF.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/execution/process-execution.test.ts`

Expected: failure because `runProcess` currently leaves stdin as an open pipe.

- [ ] **Step 3: Implement the minimal process change**

Change the spawn options to:

```ts
spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/execution/process-execution.test.ts`

Expected: pass.

### Task 2: Carry configured model and effort into runner invocation

**Files:**
- Modify: `src/bootstrap/runner-registry.ts`
- Modify: `src/execution/infrastructure/runners/claude.ts`
- Modify: `src/execution/infrastructure/runners/codex.ts`
- Modify: `src/execution/infrastructure/runners/cursor.ts`
- Test: `test/unit/bootstrap/runner-registry.test.ts`
- Test: `test/unit/execution/runners/*.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Assert configured `model` becomes the default when a request omits it; assert a request model overrides it. Assert Codex uses `-c model_reasoning_effort=\"<effort>\"` and Claude uses `--effort <effort>` when configured.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npx vitest run test/unit/bootstrap/runner-registry.test.ts test/unit/execution/runners`

Expected: failures showing registry construction discards the configuration values.

- [ ] **Step 3: Implement minimal configuration propagation**

Pass model/effort from `createConfiguredRunner` to concrete adapters. Each adapter computes `request.model ?? configuredModel`; Codex appends its `-c` override and Claude appends `--effort`. Preserve caller-supplied passthrough args and resume ordering.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `npx vitest run test/unit/bootstrap/runner-registry.test.ts test/unit/execution/runners`

Expected: pass.

### Task 3: Restore Codex, Claude, and Cursor non-interactive command parity

**Files:**
- Modify: `src/execution/contracts/runner.ts`
- Modify: `src/execution/infrastructure/runners/codex.ts`
- Modify: `src/execution/infrastructure/runners/claude.ts`
- Modify: `src/execution/infrastructure/runners/cursor.ts`
- Test: `test/unit/execution/runners/codex.test.ts`
- Test: `test/unit/execution/runners/claude.test.ts`
- Test: `test/unit/execution/runners/cursor.test.ts`

- [ ] **Step 1: Write failing command-argument tests**

Codex must include `exec --json --skip-git-repo-check --sandbox <mode> --cd <workspace> --model <model>` and the currently-supported non-interactive approval option. Claude and Cursor must retain their legacy model, effort, tool, and trust/force behavior where their current contracts represent it.

- [ ] **Step 2: Validate current installed CLI option names**

Run `codex exec --help`, `claude --help`, and `cursor agent --help` inside the sandbox. Use supported current options; do not restore a legacy flag solely because it existed.

- [ ] **Step 3: Implement only representable parity**

Extend `RunnerRequest` with workspace mode where required to translate Wake `read-only`/`branch` execution into a vendor sandbox mode. Do not invent unsupported per-tool restrictions for Codex or Cursor.

- [ ] **Step 4: Run focused adapter tests**

Run: `npx vitest run test/unit/execution/runners`

Expected: pass.

### Task 4: Make smoke exercise the real resolved configuration

**Files:**
- Modify: `src/surfaces/cli/commands/smoke.ts`
- Modify: `src/execution/infrastructure/runners/registry.ts`
- Test: `test/unit/surfaces/smoke.test.ts`

- [ ] **Step 1: Write a failing smoke test**

Assert smoke invokes the selected runner with its resolved model and effort and reports the selected configuration in its result.

- [ ] **Step 2: Implement resolved-runner metadata access**

Expose only the selected runner descriptor required by smoke; do not leak configuration through unrelated execution APIs.

- [ ] **Step 3: Run the focused smoke test**

Run: `npx vitest run test/unit/surfaces/smoke.test.ts`

Expected: pass.

### Task 5: Verify source and sandbox behavior

**Files:**
- Test: relevant unit/integration tests above

- [ ] **Step 1: Run targeted suites**

Run: `npx vitest run test/unit/execution test/unit/bootstrap/runner-registry.test.ts test/unit/surfaces/smoke.test.ts`

- [ ] **Step 2: Run lint and build**

Run: `npm run lint -- --quiet` and `npm run build`.

- [ ] **Step 3: Run sandbox smoke after rebuild/update**

Run `wake-dev smoke` and confirm its displayed command metadata contains the configured Codex model and effort. Do not retry issue #531 until the stalled run has been cancelled.

- [ ] **Step 4: Commit only parity files**

Stage only the runner, process, smoke, and corresponding test files. Commit with `fix: restore headless runner parity`.
