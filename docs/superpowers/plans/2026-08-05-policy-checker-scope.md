# Policy Checker Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the six false-positive `verify:next` findings while preserving code-level provider locality and resource-response decoding.

**Architecture:** Provider locality will treat provider names in identifiers outside their provider namespace as violations, but not inspect general-purpose text literals. Registered API field names remain centralized in transport-value constants, and the web decoder consumes the adapter field through that constant.

**Tech Stack:** Node.js, TypeScript compiler API, Vitest, TypeScript.

---

### Task 1: Narrow provider-locality path scope

**Files:**

- Modify: `test-next/architecture/provider-locality.test.ts`
- Modify: `scripts/lib/provider-locality-rule.mjs`

- [ ] **Step 1: Write the failing architecture test**

Add a path-scope case with `integrations/github/index.ts` as the discovered provider and `bootstrap/sandbox-template.ts` containing `Configure GitHub auth?` plus a template URL at `https://cli.github.com/packages`. Assert that `check(...)` returns no diagnostics.

- [ ] **Step 2: Run the test and confirm RED**

Run `npx vitest run --config vitest.next.architecture.config.ts test-next/architecture/provider-locality.test.ts`. It must fail because `pathScopeDiagnostics` reports both literals.

- [ ] **Step 3: Implement the minimal checker change**

In `pathScopeDiagnostics`, retain `matchProviders` only for `ts.isIdentifier(node)`. Remove its literal-text branch. Leave `valueScopeDiagnostics` unchanged, so identity, event-type, and stream values remain checked within a provider namespace.

- [ ] **Step 4: Run the test and confirm GREEN**

Run `npx vitest run --config vitest.next.architecture.config.ts test-next/architecture/provider-locality.test.ts`. Existing identifier leak and value-scope cases must still pass.

- [ ] **Step 5: Commit**

Run `git add test-next/architecture/provider-locality.test.ts scripts/lib/provider-locality-rule.mjs` then `git commit -m "fix: narrow provider locality checks"`.

### Task 2: Centralize the resource adapter response field

**Files:**

- Modify: `src-next/surfaces/api/contracts/transport-values.ts`
- Modify: `src-next/surfaces/web/src/api/decoders.ts`
- Create: `src-next/surfaces/web/test/decoders.test.ts`

- [ ] **Step 1: Write the failing decoder test**

Add `decodeResourceItem` coverage that passes a complete minimal resource payload with `adapter: 'github'` and asserts the decoded object has that adapter. Import from `../src/api/decoders.js`.

- [ ] **Step 2: Run the test and confirm RED**

Run `npx vitest run --config src-next/surfaces/web/vitest.config.ts src-next/surfaces/web/test/decoders.test.ts`. It must fail because the test file does not yet exist.

- [ ] **Step 3: Implement the minimal transport constant and decoder use**

Add `resourceItemFieldShape = { adapter: true }` to `transport-values.ts` and export `ResourceItemField.Adapter` using the existing `Object.keys(...)[0]!` convention. Import it in the decoder; use bracket lookup and the same field constant for the validation-path key.

- [ ] **Step 4: Run focused verification and confirm GREEN**

Run `npx vitest run --config src-next/surfaces/web/vitest.config.ts src-next/surfaces/web/test/decoders.test.ts`, then `node scripts/check-contract-vocabulary.mjs --rules=closed-vocabulary`. Both must pass.

- [ ] **Step 5: Commit**

Run `git add src-next/surfaces/api/contracts/transport-values.ts src-next/surfaces/web/src/api/decoders.ts src-next/surfaces/web/test/decoders.test.ts` then `git commit -m "fix(web): centralize resource adapter field"`.

### Task 3: Run the full target verification suite

**Files:** repository root scripts and all changed files.

- [ ] **Step 1: Run full verification**

Run `npm run verify:next`. Expect exit code 0 after catalogue, architecture, lint, format, build, web, unit, and architecture checks.

- [ ] **Step 2: Inspect repository status**

Run `git status --short`. Inspect any unexpected generated file before deciding whether to commit it.

- [ ] **Step 3: Report evidence**

Report the `verify:next` exit status and the Task 1 and Task 2 commits. Do not claim completion without a successful fresh verification run.
