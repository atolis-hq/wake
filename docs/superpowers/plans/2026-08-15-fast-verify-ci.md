# Fast Verify and CI Aggregate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `verify` a build-inclusive, filesystem-free unit gate and make `verify:ci` the complete non-live GitHub test aggregate.

**Architecture:** Keep concrete Node filesystem access as the default Bootstrap adapter, but accept a narrow text-file reader in configuration loaders so unit tests use in-memory sources. Move tests whose assertion is durable storage or workspace lifecycle into the integration tier. The CI workflow invokes one named aggregate while retaining Docker smoke separately.

**Tech Stack:** npm scripts, Vitest, TypeScript, GitHub Actions.

---

### Task 1: Define the command contracts

**Files:**
- Modify: `package.json`
- Modify: `test/architecture/test-tiering.test.ts`
- Modify: `docs/development.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write a failing architecture assertion**

Require `test` to invoke the unit suite, `verify` to invoke `check:specs`, `build`, and the unit suite, and `verify:ci` to include architecture, integration, E2E, Knip, and web tests.

- [ ] **Step 2: Run the architecture test to verify it fails**

Run: `npx vitest run --config vitest.architecture.config.ts test/architecture/test-tiering.test.ts`

- [ ] **Step 3: Implement the scripts and current-state documentation**

Set `test` to `npm run test:unit`; set `verify` to the quick checks plus build and unit tests; set `verify:ci` to `verify` plus the non-live CI suites. Document the scoped-local versus CI distinction.

- [ ] **Step 4: Re-run the architecture test**

Run: `npx vitest run --config vitest.architecture.config.ts test/architecture/test-tiering.test.ts`

### Task 2: Remove temporary filesystem writes from unit tests

**Files:**
- Modify: `src/bootstrap/config/load-config.ts`
- Modify: `src/bootstrap/fake-scenarios.ts`
- Modify: `test/unit/bootstrap/config-ownership.test.ts`
- Modify: `test/unit/bootstrap/fake-scenarios.test.ts`
- Move: `test/unit/execution/git-workspace.test.ts` to `test/integration/execution/git-workspace.test.ts`
- Move: filesystem restart case from `test/unit/control-plane/runner-control-service.test.ts` to `test/integration/control-plane/runner-control-service.test.ts`

- [ ] **Step 1: Write failing unit tests with an in-memory text reader**

Pass a reader that returns YAML text or throws `{ code: 'ENOENT' }` and assert that config and fake scenarios retain their validation behavior without creating a root.

- [ ] **Step 2: Run the two unit files to verify they fail**

Run: `npx vitest run --config vitest.unit.config.ts test/unit/bootstrap/config-ownership.test.ts test/unit/bootstrap/fake-scenarios.test.ts`

- [ ] **Step 3: Implement narrow reader injection**

Add an optional `{ readFile(path): Promise<string> }` dependency to both Bootstrap loaders; default it to Node's `readFile`, preserving production composition.

- [ ] **Step 4: Move durable tests into integration**

Preserve the existing real-disk Git workspace and FileEventJournal restart assertions under `test/integration`, with their cleanup setup retained.

- [ ] **Step 5: Re-run unit and moved integration files**

Run: `npm run test:unit` and focused `npx vitest run --config vitest.integration.config.ts` paths.

### Task 3: Wire CI to the aggregate command

**Files:**
- Modify: `.github/workflows/ci-cd.yml`

- [ ] **Step 1: Update the test job**

Replace separate verify/Knip/web steps with one `npm run verify:ci` step named as the non-live CI gate. Keep Docker smoke as its dedicated job.

- [ ] **Step 2: Run the fast gate and static workflow checks**

Run: `npm run verify` and inspect the workflow diff.

