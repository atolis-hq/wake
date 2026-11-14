# Windows Node Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failing Windows Husky hook path and make repeated local lint runs faster while preserving targeted test concurrency.

**Architecture:** Lefthook owns Git hook installation and directly launches the repository Prettier binary for staged files. ESLint retains the existing rules but uses a content-addressed local cache. Architecture tests enforce the toolchain and the evidence-based worker limits.

**Tech Stack:** Node.js 24, npm workspaces, Lefthook, Prettier, ESLint, Vitest.

---

### Task 1: Add a failing developer-tooling architecture contract

**Files:**
- Create: `test/architecture/developer-tooling.test.ts`
- Read: `package.json`
- Read: `lefthook.yml`
- Read: `vitest.integration.config.ts`
- Read: `src/surfaces/web/vitest.config.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type Manifest = {
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly ['lint-staged']?: unknown;
};

const readRootFile = (path: string): Promise<string> =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('developer tooling', () => {
  it('uses cross-platform hooks and incremental linting with bounded fixture suites', async () => {
    const [manifestText, hooks, integration, web] = await Promise.all([
      readRootFile('package.json'),
      readRootFile('lefthook.yml'),
      readRootFile('vitest.integration.config.ts'),
      readRootFile('src/surfaces/web/vitest.config.ts'),
    ]);
    const manifest = JSON.parse(manifestText) as Manifest;

    expect(manifest.devDependencies?.lefthook).toBeDefined();
    expect(manifest.devDependencies?.husky).toBeUndefined();
    expect(manifest.devDependencies?.['lint-staged']).toBeUndefined();
    expect(manifest['lint-staged']).toBeUndefined();
    expect(manifest.scripts?.prepare).toBeUndefined();
    expect(manifest.scripts?.lint).toContain('--cache');
    expect(manifest.scripts?.lint).toContain('--cache-strategy content');
    expect(manifest.scripts?.lint).toContain('node_modules/.cache/eslint/.eslintcache');
    expect(hooks).toContain('stage_fixed: true');
    expect(hooks).toContain('node node_modules/prettier/bin/prettier.cjs --write {staged_files}');
    expect(integration).toContain('maxWorkers: 4');
    expect(web).toContain('maxWorkers: 4');
  });
});
```

- [ ] **Step 2: Run the architecture test and verify RED**

Run: `npx vitest run --config vitest.architecture.config.ts test/architecture/developer-tooling.test.ts`

Expected: FAIL because `lefthook.yml` and the Lefthook dependency do not exist.

### Task 2: Replace Husky and lint-staged with Lefthook

**Files:**
- Create: `lefthook.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `.husky/pre-commit`

- [ ] **Step 1: Update dependencies mechanically**

Run: `npm uninstall --save-dev husky lint-staged`

Run: `npm install --save-dev lefthook`

Expected: `package.json` and `package-lock.json` contain Lefthook and no Husky or lint-staged dependency.

- [ ] **Step 2: Configure the staged formatter**

Create `lefthook.yml`:

```yaml
pre-commit:
  jobs:
    - name: format staged files
      glob: '*.{ts,tsx,js,mjs,cjs,json,yaml,yml,css,html}'
      run: node node_modules/prettier/bin/prettier.cjs --write {staged_files}
      stage_fixed: true
```

- [ ] **Step 3: Remove obsolete manifest configuration**

Remove the root `prepare` script and `lint-staged` object from `package.json`. Remove `.husky/pre-commit`; the ignored `.husky/_` installation output is not source.

- [ ] **Step 4: Validate Lefthook configuration**

Run: `npx lefthook validate`

Expected: exit code 0.

### Task 3: Add persistent ESLint caching

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Change only the lint command**

Set:

```json
"lint": "eslint --cache --cache-strategy content --cache-location node_modules/.cache/eslint/.eslintcache ."
```

The cache lives under the already ignored `node_modules` tree and does not change CI correctness on a cold checkout.

- [ ] **Step 2: Run the architecture test and verify GREEN**

Run: `npx vitest run --config vitest.architecture.config.ts test/architecture/developer-tooling.test.ts`

Expected: PASS, 1 test.

### Task 4: Verify real hook and incremental lint behavior

**Files:**
- Temporary fixture: `test/architecture/.lefthook-format-fixture.json` (remove after verification)

- [ ] **Step 1: Verify the hook formats and restages a staged file**

Create `test/architecture/.lefthook-format-fixture.json` with:

```json
{"wake":"windows"}
```

Run:

```text
git add -- test/architecture/.lefthook-format-fixture.json
npx lefthook run pre-commit
git diff --cached --check
git diff --cached -- test/architecture/.lefthook-format-fixture.json
git restore --staged -- test/architecture/.lefthook-format-fixture.json
```

Expected: Lefthook exits 0 and the staged diff contains Prettier's expanded JSON. Remove only `test/architecture/.lefthook-format-fixture.json` with an exact-path patch after verification.

- [ ] **Step 2: Verify ESLint caching**

Run `npm run lint` twice. Both runs must exit 0, and `node_modules/.cache/eslint/.eslintcache` must exist after the first run. Record elapsed times; the second run should avoid the multi-minute full parse observed before the change.

- [ ] **Step 3: Run focused and repository verification**

Run:

```text
npx vitest run --config vitest.architecture.config.ts test/architecture/developer-tooling.test.ts test/architecture/test-tiering.test.ts
npm run format:check
npm run verify
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit and push**

Stage only `package.json`, `package-lock.json`, `lefthook.yml`, `.husky/pre-commit`, and `test/architecture/developer-tooling.test.ts`. Commit with `fix: improve Windows Node tooling`, push `feat/event-driven-runtime`, and monitor PR #790 checks to completion.
