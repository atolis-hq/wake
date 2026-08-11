# CLI sandbox help alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a README link to default help and make `wake dev sandbox` provide the existing sandbox command and its help.

**Architecture:** Keep default help as a static Surface-owned string. Normalize the two-token developer alias in the Surface CLI parser, and keep sandbox subcommand help in the sandbox command module so it never composes or invokes Docker.

**Tech Stack:** TypeScript, Vitest, ESLint, Prettier.

---

### Task 1: Surface help and sandbox alias

**Files:**
- Modify: `src-next/surfaces/cli/usage.ts`
- Modify: `src-next/surfaces/cli/main.ts`
- Modify: `src-next/surfaces/cli/commands/sandbox.ts`
- Test: `test-next/integration/surfaces/cli-main-contract.test.ts`
- Test: `test-next/integration/surfaces/sandbox.test.ts`

- [x] **Step 1: Write failing public CLI tests**

Add assertions that default help contains the README URL and that `parseWakeCommand(['dev', 'sandbox'])` and `parseWakeCommand(['dev', 'sandbox', '--help'])` select a no-effect sandbox-help command.

- [x] **Step 2: Run focused tests to verify they fail**

Run: `npx vitest run --config vitest.next.integration.config.ts test-next/integration/surfaces/cli-main-contract.test.ts`

Expected: FAIL because `dev` is currently an unknown top-level command.

- [x] **Step 3: Implement the smallest Surface-only behaviour**

Append `https://github.com/atolis-hq/wake#readme` after Getting started. Normalize `dev sandbox` to `sandbox`; have an empty sandbox command or sole `--help` return the sandbox usage string before any Docker port call.

- [x] **Step 4: Run focused tests to verify they pass**

Run: `npx vitest run --config vitest.next.integration.config.ts test-next/integration/surfaces/cli-main-contract.test.ts test-next/unit/surfaces/cli/sandbox.test.ts`

Expected: PASS.

- [x] **Step 5: Commit implementation**

```powershell
git add src-next/surfaces/cli/usage.ts src-next/surfaces/cli/main.ts src-next/surfaces/cli/commands/sandbox.ts test-next/integration/surfaces/cli-main-contract.test.ts test-next/unit/surfaces/cli/sandbox.test.ts
git commit -m "feat: add sandbox help alias"
```
