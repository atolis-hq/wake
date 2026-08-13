# Local Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one local finishing gate that verifies legacy and target fast suites without requiring CI-only integration or E2E tests.

**Architecture:** `verify:local` composes the existing `verify` and `verify:next` commands. `verify:ci` composes `verify:local` and then explicitly runs the legacy and target integration/E2E suites, preserving full GitHub CI coverage.

**Tech Stack:** npm scripts, Vitest, TypeScript.

---

### Task 1: Specify and implement local verification composition

**Files:**
- Modify: `test/package-scripts.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the failing package-script expectations**

```ts
expect(packageJson.scripts['verify:local']).toBe('npm run verify && npm run verify:next');
expect(packageJson.scripts['verify:ci']).toBe(
  'npm run verify:local && npm run test:integration && npm run test:legacy && npm run test:next:integration && npm run test:next:e2e',
);
```

- [ ] **Step 2: Verify the contract is red**

Run: `npx vitest run test/package-scripts.test.ts`

Expected: FAIL because `verify:local` is absent and `verify:ci` starts with `npm run verify`, not `npm run verify:local`.

- [ ] **Step 3: Add the two exact package scripts**

```json
"verify:local": "npm run verify && npm run verify:next",
"verify:ci": "npm run verify:local && npm run test:integration && npm run test:legacy && npm run test:next:integration && npm run test:next:e2e"
```

- [ ] **Step 4: Verify the contract is green**

Run: `npx vitest run test/package-scripts.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the new local finishing gate**

Run: `npm run verify:local`

Expected: PASS. It must not invoke either `test:integration`, `test:next:integration`, or `test:next:e2e`.

- [ ] **Step 6: Commit**

```bash
git add package.json test/package-scripts.test.ts
git commit -m "build: add local verification gate"
```
## Correction: final command definitions (2026-08-03)

Use `verify:local = npm run verify:next` and `verify:ci = npm run verify && npm run verify:local && npm run test:integration && npm run test:legacy && npm run test:next:integration && npm run test:next:e2e`.
