# Runner Pools Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pre-release `tier` configuration and routing vocabulary with the approved `runnerPool` vocabulary, with no compatibility aliases.

**Architecture:** Keep concrete execution entries in `execution.agentRunners` and represent each ordered fallback set as `execution.runnerPools`. Workflow activations select `execution.runnerPool`, while the execution service and registry carry `runnerPool` through selection and emitted routing metadata. Rename the legacy surface too while it remains runnable, so Wake exposes one vocabulary before cutover.

**Tech Stack:** TypeScript, Zod, YAML, Vitest, current Wake configuration and target `src-next` architecture.

---

### Task 1: Lock the target contracts with failing tests

**Files:**

- Modify: `test-next/execution/runner-registry.test.ts`
- Modify: `test-next/execution/runner-selection.test.ts`
- Modify: `test-next/execution/execution-service.test.ts`
- Modify: `test-next/orchestration/{workflow-compiler,event-contracts}.test.ts`
- Modify: `test-next/bootstrap/{load-config,config-ownership,runtime}.test.ts`

- [ ] **Step 1: Rename target test inputs and assertions to the public contract**

Replace every target configuration input with:

```ts
execution: {
  agentRunners: { fake: { kind: 'fake' } },
  runnerPools: { standard: ['fake'] },
  defaultRunnerPool: 'standard',
}
```

Replace activation routes with `execution: { runnerPool: 'standard' }`, and
assert `runnerPool` in routing/event payloads. Rename test descriptions and
expected errors to say “runner pool”. Add a strict-schema assertion that the
former `tiers`, `defaultTier`, and route `tier` keys are rejected.

- [ ] **Step 2: Run the focused tests and confirm contract failures**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution test-next/orchestration/workflow-compiler.test.ts test-next/orchestration/event-contracts.test.ts test-next/bootstrap/load-config.test.ts test-next/bootstrap/config-ownership.test.ts test-next/bootstrap/runtime.test.ts
```

Expected: FAIL because current target contracts still expose `tiers`,
`defaultTier`, and `tier`.

### Task 2: Rename target execution and orchestration contracts

**Files:**

- Modify: `src-next/execution/contracts/{config,commands,views}.ts`
- Modify: `src-next/orchestration/contracts/{config,event-payload-schema}.ts`
- Modify: `src-next/execution/{application/execution-service.ts,infrastructure/runners/registry.ts}`
- Modify: `src-next/bootstrap/{runner-registry,composition-root,surface-api-execution-applications}.ts`
- Modify: `test-next/execution/{support,activation-claim,runner-registry,runner-selection,execution-service}.test.ts`
- Modify: `test-next/orchestration/{workflow-compiler,event-contracts,coordination-recovery}.test.ts`
- Modify: `test-next/bootstrap/{load-config,config-ownership,runtime}.test.ts`

- [ ] **Step 1: Replace target config and route fields**

Use these exact contract members:

```ts
readonly runnerPools: Readonly<Record<string, readonly string[]>>;
readonly defaultRunnerPool: string;

execution: {
  readonly workspace?: WorkspaceMode | undefined;
  readonly runnerPool?: string | undefined;
}
```

The Zod schemas must expose `runnerPools`, `defaultRunnerPool`, and
`runnerPool` only. Keep them strict; do not transform legacy input.

- [ ] **Step 2: Preserve selection behavior under the new names**

Rename `RunnerRegistry` constructor/state/arguments and `ExecutionService`
locals to `runnerPools` and `runnerPool`. Preserve its first-eligible selection
and in-pool fallback. Errors must identify the unknown or exhausted runner
pool, never a tier.

- [ ] **Step 3: Rename emitted target facts and presentation composition**

Update execution routing/result views and orchestration event-payload schemas
to carry `runnerPool`. Update bootstrap composition and API execution
application composition to enumerate `config.execution.runnerPools`.

- [ ] **Step 4: Run target routing proof**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution test-next/orchestration/workflow-compiler.test.ts test-next/orchestration/event-contracts.test.ts test-next/orchestration/coordination-recovery.test.ts test-next/bootstrap/load-config.test.ts test-next/bootstrap/config-ownership.test.ts test-next/bootstrap/runtime.test.ts
```

Expected: PASS, including strict rejection of all legacy field names and
same-pool fallback when the first runner is ineligible.

### Task 3: Update target fixtures and end-to-end contracts

**Files:**

- Modify: `test-next/e2e/support/world.ts`
- Modify: `test-next/e2e/scenarios/{api-domain-shape,configured-workflow,live-simple,runner-pause-fallback}.test.ts`
- Modify: `test-next/e2e/fixtures/**/config.yaml`
- Modify: `test-next/e2e/fixtures/**/config.workflows.yaml`

- [ ] **Step 1: Convert every target fixture to the breaking config shape**

Replace `tiers` with `runnerPools`, `defaultTier` with `defaultRunnerPool`,
and every workflow `tier` mapping with `runnerPool`. Keep runner names and
fallback order unchanged.

- [ ] **Step 2: Update E2E assertions**

Assert target API/domain payloads report `runnerPool`; remove assertions that
observe `tier`. Preserve the configured-workflow and pause-fallback scenarios
so they prove configuration loading and sideways fallback rather than only
unit-level behavior.

- [ ] **Step 3: Run target E2E scenarios**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e/scenarios/configured-workflow.test.ts test-next/e2e/scenarios/api-domain-shape.test.ts test-next/e2e/scenarios/live-simple.test.ts test-next/e2e/scenarios/runner-pause-fallback.test.ts
```

Expected: PASS.

### Task 4: Apply the same breaking rename to the runnable legacy surface

**Files:**

- Modify: `src/{domain/schema,domain/runner-routing,domain/workflows}.ts`
- Modify: `src/{main,cli/startup-preflight}.ts`
- Modify: `src/adapters/{runner/runner-registry,http/ui-data,http/ui-assets,github/github-issues-work-source}.ts`
- Modify: every matching legacy test under `test/{adapters,core,domain,cli}`

- [ ] **Step 1: Change legacy tests and YAML/config objects first**

Mechanically rename the approved public fields and their expectations:

```text
tiers             -> runnerPools
defaultTier       -> defaultRunnerPool
tier              -> runnerPool
Runner tier       -> runner pool
```

Do not rename unrelated English uses of “tier” in historical content or
external provider payload property names unless that property is Wake's public
routing contract.

- [ ] **Step 2: Implement the legacy schema and routing rename**

Rename schema fields, config reads, stage/command routing fields, resolved
routing metadata, error messages, UI data keys, display labels, grouping keys,
and GitHub-derived Wake routing text. Retain the exact fallback and pause
semantics; this is a vocabulary-only breaking change.

- [ ] **Step 3: Run focused legacy routing and UI tests**

Run:

```powershell
npx vitest run test/adapters/runner-registry.test.ts test/adapters/ui-data.test.ts test/domain/schema.test.ts test/domain/workflows.test.ts test/core/tick-runner.quota.test.ts test/core/tick-runner.reconcile.test.ts
```

Expected: PASS with no active runtime `tier` vocabulary.

### Task 5: Update current operator documentation and templates

**Files:**

- Modify: `docs/{configuration,workflows,getting-started,development,runner-comparison}.md`
- Modify: `templates/SETUP.md`
- Modify: current README/config examples if `rg` finds affected vocabulary

- [ ] **Step 1: Rename reference examples and descriptions**

Use `runnerPools`, `defaultRunnerPool`, and `runnerPool` in current docs and
templates. Describe a pool as an ordered runner fallback set; state explicitly
that labels are free-form and do not imply a capability hierarchy.

- [ ] **Step 2: Preserve historical records**

Do not edit dated plans, dated specs, handoffs, reports, vision inputs, or
design-history records. They may retain “tier” when accurately describing the
historical design.

- [ ] **Step 3: Run documentation and template assertions**

Run the relevant existing CLI/template tests plus:

```powershell
rg -n -i 'defaultTier|\btiers\b|\btier\b' README.md docs/configuration.md docs/workflows.md docs/getting-started.md docs/development.md docs/runner-comparison.md templates
```

Expected: no active reference/template match outside explicitly historical
context; tests PASS.

### Task 6: Complete the regression sweep and commit

**Files:**

- Modify: all files identified by Tasks 1-5 only

- [ ] **Step 1: Check the final public surface**

Run:

```powershell
rg -n -i --glob '!docs/superpowers/**' --glob '!docs/design/**' --glob '!docs/reports/**' --glob '!docs/handoffs/**' --glob '!docs/vision-inputs/**' --glob '!docs/plans/**' 'defaultTier|\btiers\b|\.tier\b|tier:' src src-next test test-next docs README.md templates
```

Expected: no active Wake configuration, runtime, test, or reference-document
usage remains. Review any survivor rather than blindly replacing it.

- [ ] **Step 2: Run full verification**

Run:

```powershell
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all commands PASS. If Windows line-ending checks flag untouched
files, verify only changed files with `npx prettier --check <paths>` as
documented in `CLAUDE.md`.

- [ ] **Step 3: Commit the breaking rename**

```powershell
git add src src-next test test-next docs README.md templates
git commit -m "refactor!: rename execution tiers to runner pools"
```
