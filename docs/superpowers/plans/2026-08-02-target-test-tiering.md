# Target Test Tiering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make target-architecture unit, integration, and E2E tests physically distinct so routine verification excludes expensive filesystem and composed-runtime tests while CI executes every tier.

**Architecture:** Directory location under `test-next/unit`, `test-next/integration`, or `test-next/e2e` is the sole classification mechanism. Narrow Vitest configs select one tier each; `verify:next` calls only unit tests and `verify:ci` explicitly composes every target tier. Live-provider E2E remains a separate opt-in subset.

**Tech Stack:** npm scripts, Vitest 4, TypeScript, Node filesystem APIs, GitHub Actions.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `test-next/unit/**` | Fast pure/module-policy target tests. |
| `test-next/integration/**` | Target tests of real local adapters, persistence, provider adapters, and surface boundaries. |
| `test-next/e2e/**` | Existing composed-runtime scenarios; retained in place. |
| `test-next/architecture/test-tiering.test.ts` then `test-next/unit/architecture/test-tiering.test.ts` | Guards tier-script/config ownership against regression before and after migration. |
| `vitest.next.unit.config.ts` | Includes only `test-next/unit/**/*.test.ts`. |
| `vitest.next.integration.config.ts` | Includes only `test-next/integration/**/*.test.ts`. |
| `vitest.next.e2e.config.ts` | Includes non-live `test-next/e2e/**/*.test.ts` serially. |
| `vitest.next.live-e2e.config.ts` | Includes only `test-next/e2e/scenarios/live-*.test.ts` serially. |
| `package.json` | Named tier commands and fast/CI aggregate commands. |
| `.github/workflows/ci-cd.yml` | Watches all four target Vitest config files. |

### Task 1: Add the failing runner-contract test

**Files:**
- Create: `test-next/architecture/test-tiering.test.ts`
- Read: `package.json`
- Read: `vitest.next.config.ts`
- Read: `vitest.next.e2e.config.ts`

- [ ] **Step 1: Create the future unit directory and write the failing contract test**

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('target test tiers', () => {
  it('keeps unit, integration, and E2E runner ownership disjoint', async () => {
    const packageJson = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
    const [unit, integration, e2e, live] = await Promise.all([
      read('vitest.next.unit.config.ts'),
      read('vitest.next.integration.config.ts'),
      read('vitest.next.e2e.config.ts'),
      read('vitest.next.live-e2e.config.ts'),
    ]);

    expect(packageJson.scripts['test:next']).toBe('npm run test:next:unit');
    expect(packageJson.scripts['verify:next']).toContain('npm run test:next:unit');
    expect(packageJson.scripts['verify:next']).not.toContain('test:next:integration');
    expect(packageJson.scripts['verify:next']).not.toContain('test:next:e2e');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:next:integration');
    expect(packageJson.scripts['verify:ci']).toContain('npm run test:next:e2e');
    expect(unit).toContain("include: ['test-next/unit/**/*.test.ts']");
    expect(integration).toContain("include: ['test-next/integration/**/*.test.ts']");
    expect(e2e).toContain("include: ['test-next/e2e/**/*.test.ts']");
    expect(e2e).toContain("exclude: ['test-next/e2e/scenarios/live-*.test.ts']");
    expect(live).toContain("include: ['test-next/e2e/scenarios/live-*.test.ts']");
  });
});
```

- [ ] **Step 2: Run the contract test and verify it fails because the tier configs and scripts do not exist**

Run: `npx vitest run test-next/architecture/test-tiering.test.ts`

Expected: FAIL with an `ENOENT` for `vitest.next.unit.config.ts`.

- [ ] **Step 3: Commit the red test**

```bash
git add test-next/architecture/test-tiering.test.ts
git commit -m "test: specify target test tiers"
```

### Task 2: Physically migrate the test tiers

**Files:**
- Move: `test-next/activities/**` ? `test-next/unit/activities/**`
- Move: `test-next/architecture/**` ? `test-next/unit/architecture/**`
- Move: `test-next/control-plane/**` ? `test-next/unit/control-plane/**`
- Move: `test-next/kernel/**` ? `test-next/unit/kernel/**`
- Move: `test-next/orchestration/**` ? `test-next/unit/orchestration/**`
- Move: `test-next/resources/**` ? `test-next/unit/resources/**`
- Move: `test-next/work/**` ? `test-next/unit/work/**`
- Move: `test-next/bootstrap/config-ownership.test.ts`, `host-config.test.ts`, `load-config.test.ts`, `paths.test.ts`, `projection-runtime.test.ts`, `self-update-application.test.ts` ? `test-next/unit/bootstrap/`
- Move: `test-next/execution/activation-claim.test.ts`, `cancellation.test.ts`, `event-contracts.test.ts`, `execution-service.test.ts`, `fake-runner.test.ts`, `lease.test.ts`, `ownership-contracts.test.ts`, `recovery.test.ts`, `run.test.ts`, `runner-registry.test.ts`, `runner-selection.test.ts`, `timeout.test.ts` ? `test-next/unit/execution/`
- Move: `test-next/integrations/**` ? `test-next/integration/integrations/**`
- Move: `test-next/persistence/**` ? `test-next/integration/persistence/**`
- Move: `test-next/surfaces/**` ? `test-next/integration/surfaces/**`
- Move: `test-next/bootstrap/initialise.test.ts`, `runtime.test.ts`, `source-update-port.test.ts`, `update-ledger.test.ts` ? `test-next/integration/bootstrap/`
- Move: `test-next/execution/process-execution.test.ts`, `prompt-templates.test.ts`, `transcripts.test.ts` ? `test-next/integration/execution/`
- Keep: `test-next/e2e/**` and `test-next/support/**`

- [ ] **Step 1: Move the unit directories and named unit files with `git mv`**

```bash
New-Item -ItemType Directory -Force test-next/unit/bootstrap, test-next/unit/execution | Out-Null
git mv test-next/activities test-next/architecture test-next/control-plane test-next/kernel test-next/orchestration test-next/resources test-next/work test-next/unit/
$unitBootstrapTests = @(
  'test-next/bootstrap/config-ownership.test.ts', 'test-next/bootstrap/host-config.test.ts',
  'test-next/bootstrap/load-config.test.ts', 'test-next/bootstrap/paths.test.ts',
  'test-next/bootstrap/projection-runtime.test.ts', 'test-next/bootstrap/self-update-application.test.ts'
)
git mv $unitBootstrapTests test-next/unit/bootstrap/
$unitExecutionTests = @(
  'test-next/execution/activation-claim.test.ts', 'test-next/execution/cancellation.test.ts',
  'test-next/execution/event-contracts.test.ts', 'test-next/execution/execution-service.test.ts',
  'test-next/execution/fake-runner.test.ts', 'test-next/execution/lease.test.ts',
  'test-next/execution/ownership-contracts.test.ts', 'test-next/execution/recovery.test.ts',
  'test-next/execution/run.test.ts', 'test-next/execution/runner-registry.test.ts',
  'test-next/execution/runner-selection.test.ts', 'test-next/execution/timeout.test.ts'
)
git mv $unitExecutionTests test-next/unit/execution/
```

- [ ] **Step 2: Move integration directories and named boundary tests with `git mv`**

```bash
New-Item -ItemType Directory -Force test-next/integration/bootstrap, test-next/integration/execution | Out-Null
git mv test-next/integrations test-next/persistence test-next/surfaces test-next/integration/
$integrationBootstrapTests = @(
  'test-next/bootstrap/initialise.test.ts', 'test-next/bootstrap/runtime.test.ts',
  'test-next/bootstrap/source-update-port.test.ts', 'test-next/bootstrap/update-ledger.test.ts'
)
git mv $integrationBootstrapTests test-next/integration/bootstrap/
$integrationExecutionTests = @(
  'test-next/execution/process-execution.test.ts', 'test-next/execution/prompt-templates.test.ts',
  'test-next/execution/transcripts.test.ts'
)
git mv $integrationExecutionTests test-next/integration/execution/
```

- [ ] **Step 3: Correct relative imports in every moved test**

Replace paths from one directory deeper without changing imported symbols:

```text
../../src-next/  -> ../../../src-next/
../support/      -> ../../support/
../e2e/          -> ../../e2e/
```

Run: `npx tsc -p tsconfig.next.json --noEmit`

Expected: FAIL only if a moved file has an uncorrected relative import; repeat the exact-path correction until it passes.

- [ ] **Step 4: Confirm directory ownership has no stray test files**

Run: `Get-ChildItem test-next -Recurse -Filter *.test.ts | Where-Object { $_.FullName -notmatch '\\(unit|integration|e2e)\\' }`

Expected: no output.

- [ ] **Step 5: Commit the mechanical test move**

```bash
git add test-next
git commit -m "test: separate target test tiers"
```

### Task 3: Implement tier-specific runners and CI aggregation

**Files:**
- Create: `vitest.next.unit.config.ts`
- Create: `vitest.next.integration.config.ts`
- Create: `vitest.next.live-e2e.config.ts`
- Modify: `vitest.next.e2e.config.ts`
- Delete: `vitest.next.config.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci-cd.yml`

- [ ] **Step 1: Create the three narrow configurations and replace the old broad target config**

```ts
// vitest.next.unit.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test-next/unit/**/*.test.ts'] } });

// vitest.next.integration.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test-next/integration/**/*.test.ts'] } });

// vitest.next.e2e.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-next/e2e/**/*.test.ts'],
    exclude: ['test-next/e2e/scenarios/live-*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});

// vitest.next.live-e2e.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-next/e2e/scenarios/live-*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
```

Remove `vitest.next.config.ts`; no broad `test-next/**/*.test.ts` include may remain.

- [ ] **Step 2: Set the package scripts to their exact tier responsibilities**

```json
{
  "test:next": "npm run test:next:unit",
  "test:next:unit": "vitest run --config vitest.next.unit.config.ts",
  "test:next:integration": "vitest run --config vitest.next.integration.config.ts",
  "test:next:e2e": "vitest run --config vitest.next.e2e.config.ts",
  "test:next:e2e:live": "vitest run --config vitest.next.live-e2e.config.ts",
  "verify:next": "npm run check:catalogue && npm run lint:architecture && npm run lint:next && npm run format:check:next && npm run build:next && npm run test:web && npm run test:next:unit",
  "verify:ci": "npm run verify && npm run verify:next && npm run test:integration && npm run test:legacy && npm run test:next:integration && npm run test:next:e2e"
}
```

- [ ] **Step 3: Add all new config names to CI path filtering**

Add these paths under `.github/workflows/ci-cd.yml`?s `relevant` filter:

```yaml
- 'vitest.next.unit.config.ts'
- 'vitest.next.integration.config.ts'
- 'vitest.next.live-e2e.config.ts'
```

Remove the deleted `vitest.next.config.ts` filter entry and retain `vitest.next.e2e.config.ts`.

- [ ] **Step 4: Run the runner-contract test and verify it passes**

Run: `npx vitest run --config vitest.next.unit.config.ts test-next/unit/architecture/test-tiering.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit runners and script policy**

```bash
git add package.json .github/workflows/ci-cd.yml vitest.next.*.config.ts test-next/unit/architecture/test-tiering.test.ts
git rm vitest.next.config.ts
git commit -m "build: make target test tiers explicit"
```

### Task 4: Verify each tier and the aggregate boundaries

**Files:**
- Verify: `package.json`
- Verify: `test-next/unit/**`
- Verify: `test-next/integration/**`
- Verify: `test-next/e2e/**`

- [ ] **Step 1: Run the fast default target verification**

Run: `npm run verify:next`

Expected: PASS without loading any test file under `test-next/integration/` or `test-next/e2e/`.

- [ ] **Step 2: Run the explicit integration tier**

Run: `npm run test:next:integration`

Expected: PASS.

- [ ] **Step 3: Run the non-live E2E tier serially**

Run: `npm run test:next:e2e`

Expected: PASS with no parallel filesystem cleanup contention.

- [ ] **Step 4: Run the full CI aggregate**

Run: `npm run verify:ci`

Expected: PASS. It runs legacy verification plus target unit, integration, and non-live E2E tiers; it does not run `test:next:e2e:live`.

- [ ] **Step 5: Confirm the worktree and commit history are clean**

Run: `git status --short`

Expected: no output.
## Amendment: architecture tier (2026-08-02)

Insert an architecture tier between unit and integration. Move all `test-next/architecture/**` files there; it is a sibling of `unit`, `integration`, and `e2e`. Create `vitest.next.architecture.config.ts` with `include: ['test-next/architecture/**/*.test.ts']`, add `test:next:architecture`, and make `verify:next` run it after `test:next:unit`. `verify:ci` obtains it through `verify:next` and then explicitly runs integration and non-live E2E. Update the runner contract test to assert this fourth exclusive config and the fast-gate inclusion.
