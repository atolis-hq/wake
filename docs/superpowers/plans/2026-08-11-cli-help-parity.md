# CLI Help Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give target `wake` help the legacy structured layout while documenting target-only public commands.

**Architecture:** Keep help as a static Surface-owned usage string read by
`src-next/main.ts` before production dependency construction. Replace only the
usage content and prove exact user-visible structure through the existing
public-main contract; command parsing and routing remain unchanged.

**Tech Stack:** TypeScript, Vitest, Prettier, ESLint.

---

## File map

- Modify `src-next/surfaces/cli/usage.ts` — static public help text.
- Modify `test-next/integration/surfaces/cli-main-contract.test.ts` —
  dependency-free public help assertions.
- Modify `src-next/surfaces/cli/cli-surface.spec.md` — document the rendered
  help contract after implementation.

### Task 1: Render structured target help

**Files:**

- Modify: `test-next/integration/surfaces/cli-main-contract.test.ts`
- Modify: `src-next/surfaces/cli/usage.ts`

- [ ] **Step 1: Write the failing public-help assertions.**

  In `cli-main-contract.test.ts`, add a test beside the existing help alias
  table that invokes `main()` with `--help`, `-h`, `help`, and `[]`, captures
  output, and asserts each contains:

  ```ts
  expect(output.join('')).toContain('Wake — an autonomous agent control plane for software development.');
  expect(output.join('')).toContain('  wake init <path>           Scaffold a new Wake home directory');
  expect(output.join('')).toContain('Getting started:');
  expect(output.join('')).toContain('Additional target commands:');
  expect(output.join('')).toContain('  wake api                   Run the target API surface');
  expect(output.join('')).toContain('Runtime commands (tick/start/ui/smoke/audit/correlate/validate-state)');
  ```

- [ ] **Step 2: Run the focused test and observe failure.**

  Run:

  ```powershell
  npx vitest run --config vitest.next.integration.config.ts test-next/integration/surfaces/cli-main-contract.test.ts
  ```

  Expected: FAIL because the current usage is one compact command synopsis.

- [ ] **Step 3: Replace the static usage string.**

  In `src-next/surfaces/cli/usage.ts`, replace the one-line value with a
  template literal containing the legacy title, shared-command descriptions,
  getting-started section, sandbox delegation guidance, and this target-only
  section:

  ```text
  Additional target commands:
    wake api                   Run the target API surface
    wake sandbox-entrypoint    Run the sandbox resident entrypoint
    wake self-update           Safely update a source installation
  ```

  Do not add internal commands or alter `src-next/main.ts` alias handling.

- [ ] **Step 4: Run the focused public-main test.**

  Run the Step 2 command.

  Expected: PASS; the existing no-composition assertions continue to pass.

- [ ] **Step 5: Commit the behavior and test.**

  ```powershell
  git add src-next/surfaces/cli/usage.ts test-next/integration/surfaces/cli-main-contract.test.ts
  git commit -m "feat: align target CLI help output"
  ```

### Task 2: Specify and verify help parity

**Files:**

- Modify: `src-next/surfaces/cli/cli-surface.spec.md`

- [ ] **Step 1: Document the help contract.**

  Add a requirement that all public help forms render the shared legacy-style
  layout without composing runtime dependencies, and that target-only public
  commands appear under **Additional target commands**.

- [ ] **Step 2: Run focused quality gates.**

  Run:

  ```powershell
  npm run lint:next
  npx prettier --check src-next/surfaces/cli/usage.ts test-next/integration/surfaces/cli-main-contract.test.ts
  npx tsc -p tsconfig.next.json --noEmit
  npm run check:specs
  ```

  Expected: every command exits 0.

- [ ] **Step 3: Commit the specification.**

  ```powershell
  git add src-next/surfaces/cli/cli-surface.spec.md
  git commit -m "docs: specify target CLI help parity"
  ```

## Self-review

Task 1 covers the approved legacy layout, target-only commands, every help
entry form, and pre-composition behavior. Task 2 covers the durable Surface
contract and checks type, formatting, lint, and spec freshness. No parsing,
routing, package, or runtime changes are in scope.
