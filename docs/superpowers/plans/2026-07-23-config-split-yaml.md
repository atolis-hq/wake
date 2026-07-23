# Config Split + YAML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `config.json` with any number of YAML files matching `config*.yaml` in the Wake home root, deep-merged together (sorted by filename), so operators can split configuration however they like instead of Wake dictating a fixed layout. Ship a sensible default split out of the box: `config.yaml` (infra/operational — paths, sandbox, dev, scheduler, transcripts, ui, sources, sinks) and `config.workflows.yaml` (behavior/policy — runners, tiers, defaultTier, workflows, workflowSelectors, commands, stages).

**Architecture:** `wakeConfigSchema` in `src/domain/schema.ts` is unchanged in content but restructured so two exported sub-schemas (`wakeInfraConfigSchema`, `wakeWorkflowConfigSchema`) can be `.pick()`ed out of the same base object — used only by `wake init`'s scaffolder to write the default two-file split, not by loading. Loading is generic: `src/config/discover-config-files.ts` finds every `config*.yaml` file in the wake root, `src/lib/deep-merge.ts` folds their raw YAML content together in filename-sort order (later file wins on conflicting keys, recursively for nested objects), and `src/config/load-config.ts` validates the merged result through the unchanged `wakeConfigSchema`. A pre-split Wake home with only `config.json` keeps working via a fallback read — Wake never auto-migrates or rewrites it, and (this is the key behavior change from earlier config handling) **Wake no longer writes any resolved config back to disk on every tick** — that write-back wasn't load-bearing (nothing re-reads it; the control-plane UI uses the in-memory config `buildRuntime` already holds) and it would fight against letting operators split files however they want. `wake init` still writes the initial two files once, at scaffold time only.

**Tech Stack:** TypeScript, zod v4, the `yaml` npm package (new dependency) for parse/stringify, vitest.

## Global Constraints

- Run `npm run verify` before considering any task done; it is lint + format:check + build + test.
- On Windows, `format:check` false-positives on untouched files (CRLF vs LF) — ignore those, but every file you touch must pass `npx prettier --check <file>` and be written with `npx prettier --write --end-of-line lf <file>`.
- Do not skip lint — unused imports are easy to introduce when splitting/moving code, and Task 10 deliberately deletes a method — make sure its now-unused imports go with it.
- No comments beyond what's already in the code unless the WHY is genuinely non-obvious (see CLAUDE.md style rules).
- Reference docs (`README.md`, everything under `docs/` except `docs/handoffs/`, `docs/plans/`, `docs/reports/`, `docs/vision-inputs/`, `docs/adrs/`, `docs/superpowers/`) must describe only the current state — no "this used to be config.json" prose except the one intentional legacy-fallback paragraph in Task 12.
- Commit after each task.

---

### Task 1: Add YAML file IO

**Files:**
- Modify: `package.json`
- Create: `src/lib/yaml-file.ts`
- Test: `test/lib/yaml-file.test.ts`

**Interfaces:**
- Produces: `writeYamlFile(path: string, value: unknown): Promise<void>`, `readYamlFile<T>(path: string): Promise<T>` — used by Task 6 (load-config) and Task 8 (scaffold-assets).

- [ ] **Step 1: Add the `yaml` dependency**

```bash
npm install yaml
```

Confirm `package.json` now has `"yaml": "^2.x.x"` under `"dependencies"` (runtime dependency, not devDependencies).

- [ ] **Step 2: Write the failing test**

Create `test/lib/yaml-file.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readYamlFile, writeYamlFile } from '../../src/lib/yaml-file.js';

describe('yaml-file', () => {
  it('round-trips an object through writeYamlFile and readYamlFile', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-yaml-file-'));
    const path = join(dir, 'nested', 'example.yaml');

    await writeYamlFile(path, { schemaVersion: 1, sandbox: { image: 'wake-sandbox' } });
    const result = await readYamlFile<{ schemaVersion: number; sandbox: { image: string } }>(
      path,
    );

    expect(result).toEqual({ schemaVersion: 1, sandbox: { image: 'wake-sandbox' } });
  });

  it('writes human-readable YAML, not JSON', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-yaml-file-'));
    const path = join(dir, 'example.yaml');

    await writeYamlFile(path, { sandbox: { image: 'wake-sandbox' } });
    const raw = await readFile(path, 'utf8');

    expect(raw).toContain('sandbox:');
    expect(raw).toContain('image: wake-sandbox');
    expect(raw).not.toContain('{');
  });
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `npx vitest run test/lib/yaml-file.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/yaml-file.js'`

- [ ] **Step 3: Implement `src/lib/yaml-file.ts`**

Mirror the existing `src/lib/json-file.ts` (same temp-file-then-rename write pattern, so a crash mid-write never leaves a truncated config file):

```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';

export async function writeYamlFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, stringify(value), 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readYamlFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return parse(raw) as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/yaml-file.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write --end-of-line lf src/lib/yaml-file.ts test/lib/yaml-file.test.ts package.json package-lock.json
git add package.json package-lock.json src/lib/yaml-file.ts test/lib/yaml-file.test.ts
git commit -m "Add YAML file read/write helpers"
```

---

### Task 2: Split `wakeConfigSchema` into infra/workflow sub-schemas

**Files:**
- Modify: `src/domain/schema.ts:454-830`
- Test: `test/domain/config-schema-split.test.ts` (new)

**Interfaces:**
- Produces: `wakeInfraConfigSchema` (ZodObject, keys: `schemaVersion`, `paths`, `sandbox`, `dev`, `scheduler`, `transcripts`, `ui`, `sources`, `sinks`), `wakeWorkflowConfigSchema` (ZodObject, keys: `runners`, `tiers`, `defaultTier`, `workflows`, `workflowSelectors`, `commands`, `stages`) — both exported from `src/domain/schema.ts`. Only used by Task 3's `splitWakeConfig`, which only `wake init` (Task 8) calls, to write the *default* two-file split at scaffold time. `wakeConfigSchema` and `parseWakeConfig` keep their exact current external behavior — this task only changes how the schema is assembled internally.

This task is pure code motion: no field, default, or validation rule changes. Read `src/domain/schema.ts` yourself first (lines 454-830) to see the exact current text before editing — this plan gives you the anchors to cut at, not a full retype, because retyping ~260 lines of nested zod risks a transcription bug that a partial-anchor edit avoids entirely.

- [ ] **Step 1: Write the failing test first**

Create `test/domain/config-schema-split.test.ts`. This is the regression guard: it fails the moment someone adds a new top-level `wakeConfigSchema` field without deciding which default file it belongs in.

```ts
import { describe, expect, it } from 'vitest';

import {
  wakeConfigSchema,
  wakeInfraConfigSchema,
  wakeWorkflowConfigSchema,
} from '../../src/domain/schema.js';

describe('wakeConfigSchema split', () => {
  it('partitions every top-level config key into exactly one of infra or workflow', () => {
    const allKeys = Object.keys(wakeConfigSchema.def.innerType.shape ?? wakeConfigSchema.shape);
    const infraKeys = new Set(Object.keys(wakeInfraConfigSchema.shape));
    const workflowKeys = new Set(Object.keys(wakeWorkflowConfigSchema.shape));

    for (const key of allKeys) {
      const inInfra = infraKeys.has(key);
      const inWorkflow = workflowKeys.has(key);
      expect(inInfra || inWorkflow, `key "${key}" must be in exactly one sub-schema`).toBe(true);
      expect(inInfra && inWorkflow, `key "${key}" must not be in both sub-schemas`).toBe(false);
    }

    expect(infraKeys.size + workflowKeys.size).toBe(allKeys.length);
  });

  it('keeps runners/tiers/workflows/commands/stages together in the workflow schema', () => {
    const workflowKeys = Object.keys(wakeWorkflowConfigSchema.shape).sort();
    expect(workflowKeys).toEqual(
      ['commands', 'defaultTier', 'runners', 'stages', 'tiers', 'workflowSelectors', 'workflows'].sort(),
    );
  });

  it('keeps paths/sandbox/sources/ui together in the infra schema', () => {
    const infraKeys = Object.keys(wakeInfraConfigSchema.shape).sort();
    expect(infraKeys).toEqual(
      ['dev', 'paths', 'sandbox', 'schemaVersion', 'scheduler', 'sinks', 'sources', 'transcripts', 'ui'].sort(),
    );
  });
});
```

If `wakeConfigSchema.def.innerType.shape` doesn't resolve on your zod version (check with a quick `console.log(Object.keys(wakeConfigSchema))` in a scratch script, or read `node_modules/zod/v4/classic/schemas.d.ts` for the effects-schema shape), adjust that one line to whatever zod v4 exposes for reading a refined schema's underlying shape — the two assertions below it are what actually matter and don't need changing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/domain/config-schema-split.test.ts`
Expected: FAIL — `wakeInfraConfigSchema` / `wakeWorkflowConfigSchema` are not exported yet.

- [ ] **Step 3: Edit `src/domain/schema.ts`**

Find (around line 454):

```ts
export const wakeConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
```

Replace with:

```ts
const wakeConfigBaseSchema = z.object({
  schemaVersion: z.literal(1).default(1),
```

(This de-indents the rest of the object body by two spaces — don't hand-edit every line, `prettier --write` in Step 6 will fix indentation for you.)

Find the end of that object, right before the existing `.superRefine` call (around line 713-715):

```ts
    sinks: z.record(z.string(), sinkEntrySchema).default({}),
  })
  .superRefine((config, ctx) => {
```

Replace with:

```ts
  sinks: z.record(z.string(), sinkEntrySchema).default({}),
});

export const wakeInfraConfigSchema = wakeConfigBaseSchema.pick({
  schemaVersion: true,
  paths: true,
  sandbox: true,
  dev: true,
  scheduler: true,
  transcripts: true,
  ui: true,
  sources: true,
  sinks: true,
});

export const wakeWorkflowConfigSchema = wakeConfigBaseSchema.pick({
  runners: true,
  tiers: true,
  defaultTier: true,
  workflows: true,
  workflowSelectors: true,
  commands: true,
  stages: true,
});

export const wakeConfigSchema = wakeConfigBaseSchema.superRefine((config, ctx) => {
```

Everything inside the `superRefine` body (the workflow/command validation logic) stays completely untouched — you're only changing the three lines around it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/domain/config-schema-split.test.ts`
Expected: PASS (3 tests). If Step 1's `allKeys` line needed adjusting, iterate here.

- [ ] **Step 5: Run the full existing schema/config test suite to confirm no behavior changed**

Run: `npx vitest run test/domain test/config`
Expected: PASS — every pre-existing test in these directories still passes unchanged, proving `wakeConfigSchema`'s validated output is identical to before.

- [ ] **Step 6: Format, build, and commit**

```bash
npx prettier --write --end-of-line lf src/domain/schema.ts test/domain/config-schema-split.test.ts
npm run build
git add src/domain/schema.ts test/domain/config-schema-split.test.ts
git commit -m "Split wakeConfigSchema into infra/workflow sub-schemas"
```

---

### Task 3: `splitWakeConfig` helper

**Files:**
- Create: `src/config/split-config.ts`
- Test: `test/config/split-config.test.ts`

**Interfaces:**
- Consumes: `wakeInfraConfigSchema`, `wakeWorkflowConfigSchema` from Task 2; `WakeConfig` type from `src/domain/types.js`.
- Produces: `splitWakeConfig(config: WakeConfig): { infra: Record<string, unknown>; workflow: Record<string, unknown> }` — used only by Task 8 (`wake init`'s scaffolder) to write the default two-file layout.

- [ ] **Step 1: Write the failing test**

Create `test/config/split-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { splitWakeConfig } from '../../src/config/split-config.js';

describe('splitWakeConfig', () => {
  it('puts sandbox/sources/paths in infra and runners/workflows in workflow', () => {
    const config = createDefaultWakeConfig('/tmp/wake-home');

    const { infra, workflow } = splitWakeConfig(config);

    expect(infra).toHaveProperty('sandbox');
    expect(infra).toHaveProperty('sources');
    expect(infra).toHaveProperty('paths');
    expect(infra).not.toHaveProperty('runners');
    expect(infra).not.toHaveProperty('workflows');

    expect(workflow).toHaveProperty('runners');
    expect(workflow).toHaveProperty('workflows');
    expect(workflow).toHaveProperty('tiers');
    expect(workflow).not.toHaveProperty('sandbox');
    expect(workflow).not.toHaveProperty('paths');
  });

  it('preserves the actual values, not just the keys', () => {
    const config = createDefaultWakeConfig('/tmp/wake-home');

    const { infra, workflow } = splitWakeConfig(config);

    expect(infra.sandbox).toEqual(config.sandbox);
    expect(workflow.defaultTier).toBe(config.defaultTier);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/split-config.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/split-config.js'`

- [ ] **Step 3: Implement `src/config/split-config.ts`**

```ts
import { wakeInfraConfigSchema, wakeWorkflowConfigSchema } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';

const infraKeys = Object.keys(wakeInfraConfigSchema.shape) as (keyof WakeConfig)[];
const workflowKeys = Object.keys(wakeWorkflowConfigSchema.shape) as (keyof WakeConfig)[];

export function splitWakeConfig(config: WakeConfig): {
  infra: Record<string, unknown>;
  workflow: Record<string, unknown>;
} {
  const infra: Record<string, unknown> = {};
  for (const key of infraKeys) {
    infra[key] = config[key];
  }

  const workflow: Record<string, unknown> = {};
  for (const key of workflowKeys) {
    workflow[key] = config[key];
  }

  return { infra, workflow };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/split-config.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Format, build, and commit**

```bash
npx prettier --write --end-of-line lf src/config/split-config.ts test/config/split-config.test.ts
npm run build
git add src/config/split-config.ts test/config/split-config.test.ts
git commit -m "Add splitWakeConfig helper"
```

---

### Task 4: Deep-merge helper for combining multiple raw config files

**Files:**
- Create: `src/lib/deep-merge.ts`
- Test: `test/lib/deep-merge.test.ts`

**Interfaces:**
- Produces: `deepMergeRaw(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown>` — used by Task 6 (`load-config.ts`) to fold multiple `config*.yaml` files together. Plain-object values merge key-by-key recursively; arrays and primitives in `source` replace whatever was in `target` wholesale (no array concatenation — that keeps merge behavior predictable when two files both set e.g. `sources.github.repos`).

- [ ] **Step 1: Write the failing test**

Create `test/lib/deep-merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { deepMergeRaw } from '../../src/lib/deep-merge.js';

describe('deepMergeRaw', () => {
  it('merges disjoint top-level keys from both objects', () => {
    const result = deepMergeRaw({ sandbox: { image: 'a' } }, { runners: { fake: { kind: 'fake' } } });

    expect(result).toEqual({ sandbox: { image: 'a' }, runners: { fake: { kind: 'fake' } } });
  });

  it('recursively merges nested objects instead of replacing the whole subtree', () => {
    const result = deepMergeRaw(
      { sources: { github: { enabled: true } } },
      { sources: { github: { repos: ['org/repo'] } } },
    );

    expect(result).toEqual({ sources: { github: { enabled: true, repos: ['org/repo'] } } });
  });

  it('lets the source value win on a direct key conflict', () => {
    const result = deepMergeRaw({ defaultTier: 'standard' }, { defaultTier: 'deep' });

    expect(result.defaultTier).toBe('deep');
  });

  it('replaces arrays wholesale rather than concatenating them', () => {
    const result = deepMergeRaw({ sources: { github: { repos: ['a'] } } }, { sources: { github: { repos: ['b'] } } });

    expect(result.sources).toEqual({ github: { repos: ['b'] } });
  });

  it('does not mutate either input', () => {
    const target = { sandbox: { image: 'a' } };
    const source = { sandbox: { containerName: 'b' } };

    deepMergeRaw(target, source);

    expect(target).toEqual({ sandbox: { image: 'a' } });
    expect(source).toEqual({ sandbox: { containerName: 'b' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/deep-merge.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/deep-merge.js'`

- [ ] **Step 3: Implement `src/lib/deep-merge.ts`**

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMergeRaw(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    result[key] =
      isPlainObject(sourceValue) && isPlainObject(targetValue)
        ? deepMergeRaw(targetValue, sourceValue)
        : sourceValue;
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/deep-merge.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Format, build, and commit**

```bash
npx prettier --write --end-of-line lf src/lib/deep-merge.ts test/lib/deep-merge.test.ts
npm run build
git add src/lib/deep-merge.ts test/lib/deep-merge.test.ts
git commit -m "Add deepMergeRaw for combining multiple config files"
```

---

### Task 5: Discover every `config*.yaml` file in the Wake home root

**Files:**
- Create: `src/config/discover-config-files.ts`
- Test: `test/config/discover-config-files.test.ts`

**Interfaces:**
- Produces: `discoverConfigFiles(wakeRoot: string): Promise<string[]>` — absolute paths of every file directly under `wakeRoot` matching `config.yaml` or `config.<anything>.yaml`, sorted alphabetically by filename. Used by Task 6 (`load-config.ts`) as the read side of the split — this is the piece that makes "split however you like" actually work, since any new `config.<label>.yaml` file the operator drops in gets picked up with no code change.

- [ ] **Step 1: Write the failing test**

Create `test/config/discover-config-files.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverConfigFiles } from '../../src/config/discover-config-files.js';

describe('discoverConfigFiles', () => {
  it('finds config.yaml and config.<label>.yaml but not unrelated files', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-discover-config-'));
    await writeFile(join(dir, 'config.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.workflows.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.local.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.json'), '', 'utf8');
    await writeFile(join(dir, 'configuration.yaml'), '', 'utf8');
    await writeFile(join(dir, 'config.yaml.abc123.tmp'), '', 'utf8');
    await mkdir(join(dir, 'workspaces'), { recursive: true });

    const found = await discoverConfigFiles(dir);

    expect(found).toEqual([
      join(dir, 'config.local.yaml'),
      join(dir, 'config.workflows.yaml'),
      join(dir, 'config.yaml'),
    ]);
  });

  it('returns an empty array when the directory has no config*.yaml files', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-discover-config-'));

    const found = await discoverConfigFiles(dir);

    expect(found).toEqual([]);
  });

  it('returns an empty array when the directory does not exist', async () => {
    const found = await discoverConfigFiles(resolve('/nonexistent/wake-home'));

    expect(found).toEqual([]);
  });
});
```

Note the expected sort order in the first test: plain alphabetical sort puts `config.local.yaml` and `config.workflows.yaml` before `config.yaml` (`'l'` and `'w'` both sort before `'y'` at the first differing character) — that's intentional and gets documented for operators in Task 12, not a bug to fix.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/discover-config-files.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/discover-config-files.js'`

- [ ] **Step 3: Implement `src/config/discover-config-files.ts`**

```ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const configFileNamePattern = /^config(\..+)?\.yaml$/;

export async function discoverConfigFiles(wakeRoot: string): Promise<string[]> {
  const entries = await readdir(wakeRoot, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile() && configFileNamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(wakeRoot, name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/discover-config-files.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Format, build, and commit**

```bash
npx prettier --write --end-of-line lf src/config/discover-config-files.ts test/config/discover-config-files.test.ts
npm run build
git add src/config/discover-config-files.ts test/config/discover-config-files.test.ts
git commit -m "Add discoverConfigFiles for the config*.yaml glob"
```

---

### Task 6: Rewrite `load-config.ts` to merge discovered files, with legacy fallback

**Files:**
- Modify: `src/config/load-config.ts`
- Test: `test/config/load-config.test.ts`

**Interfaces:**
- Consumes: `discoverConfigFiles` (Task 5), `deepMergeRaw` (Task 4), `readYamlFile` (Task 1).
- Produces: `loadWakeConfig(options?: { wakeRoot?: string }): Promise<WakeConfig>` — the `configFile` option is removed entirely (no caller ever passed anything other than the default path, confirmed via `grep -n "loadWakeConfig(" src/main.ts` showing all 5 call sites pass `stateStore.paths.configFile` unconditionally). Consumed next by Task 9 (`main.ts`), which drops the now-removed option from its call sites.

- [ ] **Step 1: Replace `test/config/load-config.test.ts`**

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadWakeConfig } from '../../src/config/load-config.js';

describe('loadWakeConfig', () => {
  it('always resolves paths.wakeRoot from the passed-in wakeRoot, never from a stale config file value', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    // Simulate a wake-home whose config.yaml still has an old
    // container-context wakeRoot baked in (e.g. "/wake") from before this
    // config was ever read directly on the host.
    await writeFile(
      join(dir, 'config.yaml'),
      'paths:\n  wakeRoot: /wake\n  promptsRoot: /wake/prompts\n',
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.paths.wakeRoot).toBe(dir);
  });

  it('still honors an explicit promptsRoot override from config.yaml', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    const customPromptsRoot = join(dir, 'custom-prompts');
    await writeFile(join(dir, 'config.yaml'), `paths:\n  promptsRoot: ${customPromptsRoot}\n`, 'utf8');

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.paths.promptsRoot).toBe(customPromptsRoot);
    expect(config.paths.wakeRoot).toBe(dir);
  });

  it('deep-merges every config*.yaml file present, sorted by filename', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(join(dir, 'config.yaml'), 'sandbox:\n  image: custom-image\n', 'utf8');
    await writeFile(join(dir, 'config.workflows.yaml'), 'defaultTier: deep\n', 'utf8');
    await writeFile(
      join(dir, 'config.sources.yaml'),
      'sources:\n  github:\n    enabled: true\n    repos: [org/repo]\n',
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.image).toBe('custom-image');
    expect(config.defaultTier).toBe('deep');
    expect(config.sources.github.enabled).toBe(true);
    expect(config.sources.github.repos).toEqual(['org/repo']);
  });

  it('falls back to a legacy combined config.json when no config*.yaml file exists', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ sandbox: { image: 'legacy-image' }, defaultTier: 'deep' }),
      'utf8',
    );

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.image).toBe('legacy-image');
    expect(config.defaultTier).toBe('deep');
  });

  it('ignores the legacy config.json once any config*.yaml file exists', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'wake-load-config-'));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ sandbox: { image: 'legacy-image' } }), 'utf8');
    await writeFile(join(dir, 'config.yaml'), 'sandbox:\n  image: current-image\n', 'utf8');

    const config = await loadWakeConfig({ wakeRoot: dir });

    expect(config.sandbox.image).toBe('current-image');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/load-config.test.ts`
Expected: FAIL — current implementation still reads a single `configFile` path as JSON.

- [ ] **Step 3: Rewrite `src/config/load-config.ts`**

```ts
import { resolve, join } from 'node:path';
import { access } from 'node:fs/promises';

import { readJsonFile } from '../lib/json-file.js';
import { readYamlFile } from '../lib/yaml-file.js';
import { deepMergeRaw } from '../lib/deep-merge.js';
import { parseWakeConfig } from '../domain/schema.js';
import type { WakeConfig } from '../domain/types.js';
import { discoverConfigFiles } from './discover-config-files.js';

async function readLegacyConfigIfPresent(wakeRoot: string): Promise<Record<string, unknown>> {
  const legacyConfigFile = join(wakeRoot, 'config.json');
  try {
    await access(legacyConfigFile);
  } catch {
    return {};
  }
  return readJsonFile<Record<string, unknown>>(legacyConfigFile);
}

export async function loadWakeConfig(options?: { wakeRoot?: string }): Promise<WakeConfig> {
  const wakeRoot = options?.wakeRoot ?? resolve(process.cwd(), '.wake');

  const configFiles = await discoverConfigFiles(wakeRoot);

  let raw: Record<string, unknown>;
  if (configFiles.length > 0) {
    raw = {};
    for (const configFile of configFiles) {
      raw = deepMergeRaw(raw, await readYamlFile<Record<string, unknown>>(configFile));
    }
  } else {
    // Pre-split Wake homes only have a single config.json — Wake reads it
    // directly rather than requiring a migration step. It stays untouched
    // on disk; nothing here writes it back out (see docs/configuration.md).
    raw = await readLegacyConfigIfPresent(wakeRoot);
  }

  // wakeRoot is always the live invocation's --wake-root/cwd, never a value
  // to accept from a (possibly stale, possibly container-context) config
  // file — spread rawPaths first so wakeRoot always wins. promptsRoot and
  // any other paths key stay file-overridable.
  const rawPaths = (raw.paths as Record<string, unknown> | undefined) ?? {};
  return parseWakeConfig({
    ...raw,
    paths: {
      ...rawPaths,
      wakeRoot,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/load-config.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write --end-of-line lf src/config/load-config.ts test/config/load-config.test.ts
git add src/config/load-config.ts test/config/load-config.test.ts
git commit -m "Load config.yaml + workflows.yaml with legacy config.json fallback"
```

(`npm run build` will still show errors in `src/main.ts` at this point — it passes a `configFile` option this file no longer accepts. That's expected; Task 9 fixes it.)

---

### Task 7: Add default file paths to `WakePaths`

**Files:**
- Modify: `src/lib/paths.ts:20`
- Test: `test/lib/paths.test.ts:10`

**Interfaces:**
- Produces: `paths.configFile` → `<wakeRoot>/config.yaml`, `paths.workflowsConfigFile` → `<wakeRoot>/config.workflows.yaml`. These name the *default* two-file layout `wake init` scaffolds (Task 8) — they are not read specially by `load-config.ts` (Task 6 discovers whatever `config*.yaml` files actually exist), just the two canonical names Wake ships with.

- [ ] **Step 1: Update the failing assertion**

In `test/lib/paths.test.ts`, replace:

```ts
  it('keeps user-facing paths at the visible wakeRoot', () => {
    expect(paths.configFile).toBe(join(wakeRoot, 'config.json'));
    expect(paths.workspaceRoot).toBe(join(wakeRoot, 'workspaces'));
    expect(paths.workspaceDir('work-1')).toBe(join(wakeRoot, 'workspaces', 'work-1'));
  });
```

with:

```ts
  it('keeps user-facing paths at the visible wakeRoot', () => {
    expect(paths.configFile).toBe(join(wakeRoot, 'config.yaml'));
    expect(paths.workflowsConfigFile).toBe(join(wakeRoot, 'config.workflows.yaml'));
    expect(paths.workspaceRoot).toBe(join(wakeRoot, 'workspaces'));
    expect(paths.workspaceDir('work-1')).toBe(join(wakeRoot, 'workspaces', 'work-1'));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/paths.test.ts`
Expected: FAIL — `paths.configFile` still resolves to `config.json`, `workflowsConfigFile` is `undefined`.

- [ ] **Step 3: Edit `src/lib/paths.ts`**

Replace:

```ts
    configFile: join(wakeRoot, 'config.json'),
```

with:

```ts
    configFile: join(wakeRoot, 'config.yaml'),
    workflowsConfigFile: join(wakeRoot, 'config.workflows.yaml'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/paths.test.ts`
Expected: PASS

- [ ] **Step 5: Format, build, and commit**

```bash
npx prettier --write --end-of-line lf src/lib/paths.ts test/lib/paths.test.ts
npm run build
git add src/lib/paths.ts test/lib/paths.test.ts
git commit -m "Add config.workflows.yaml to WakePaths"
```

---

### Task 8: `wake init` scaffolds the default two-file split

**Files:**
- Modify: `src/cli/scaffold-assets.ts`
- Test: `test/cli/scaffold-assets.test.ts`, `test/cli/init-command.test.ts`

**Interfaces:**
- Consumes: `splitWakeConfig` (Task 3), `writeYamlFile` (Task 1).
- Produces: `scaffoldWakeHome` now writes `<wakeRoot>/config.yaml` and `<wakeRoot>/config.workflows.yaml` instead of `<wakeRoot>/config.json`.

- [ ] **Step 1: Update `test/cli/scaffold-assets.test.ts`**

Replace every occurrence of:

```ts
    const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));
```

with:

```ts
    const config = parse(await readFile(join(wakeRoot, 'config.yaml'), 'utf8'));
```

(there are 4 occurrences — `containerName`/`image`/`imageRepository` and the two `dev.mode` assertions all read infra fields, so `config.yaml` is correct for all of them). Add the import at the top of the file:

```ts
import { parse } from 'yaml';
```

Rename the two `describe` blocks currently reading `'scaffoldWakeHome config.json'` to `'scaffoldWakeHome config.yaml'` (cosmetic).

- [ ] **Step 2: Update `test/cli/init-command.test.ts`**

Replace:

```ts
    const config = await readFile(join(result.wakeRoot, 'config.json'), 'utf8');

    expect(config).toContain('"sandbox"');
    expect(config).toContain(`"repoRoot": "${repoRoot.replaceAll('\\', '\\\\')}"`);
```

with:

```ts
    const config = await readFile(join(result.wakeRoot, 'config.yaml'), 'utf8');

    expect(config).toContain('sandbox:');
    expect(config).toContain(`repoRoot: ${repoRoot}`);
```

(YAML doesn't quote plain scalar strings or double-escape backslashes the way `JSON.stringify` does, so the `repoRoot` assertion simplifies.)

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run test/cli/scaffold-assets.test.ts test/cli/init-command.test.ts`
Expected: FAIL — `scaffoldWakeHome` still writes `config.json`.

- [ ] **Step 4: Edit `src/cli/scaffold-assets.ts`**

Add imports:

```ts
import { writeYamlFile } from '../lib/yaml-file.js';
import { splitWakeConfig } from '../config/split-config.js';
```

Replace:

```ts
  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    writeJsonFile(join(wakeRoot, 'config.json'), config),
  ]);
```

with:

```ts
  const { infra, workflow } = splitWakeConfig(config);

  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    writeYamlFile(join(wakeRoot, 'config.yaml'), infra),
    writeYamlFile(join(wakeRoot, 'config.workflows.yaml'), workflow),
  ]);
```

Remove the now-unused `writeJsonFile` import (`grep -n "writeJsonFile" src/cli/scaffold-assets.ts` should show only the import line afterward — delete it, or lint will flag it as unused).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cli/scaffold-assets.test.ts test/cli/init-command.test.ts`
Expected: PASS

- [ ] **Step 6: Format, build, lint, and commit**

```bash
npx prettier --write --end-of-line lf src/cli/scaffold-assets.ts test/cli/scaffold-assets.test.ts test/cli/init-command.test.ts
npm run build
npx eslint src/cli/scaffold-assets.ts
git add src/cli/scaffold-assets.ts test/cli/scaffold-assets.test.ts test/cli/init-command.test.ts
git commit -m "wake init scaffolds config.yaml + config.workflows.yaml"
```

---

### Task 9: Simplify `main.ts` — drop the removed `configFile` option and the tick-time config write-back

**Files:**
- Modify: `src/main.ts` (5 `loadWakeConfig` call sites + the 1 `writeConfig` call)

**Interfaces:**
- Consumes: `loadWakeConfig({ wakeRoot })` (Task 6's new signature, no `configFile`).

This is the behavior change discussed above: Wake stops writing the resolved config back to disk on every tick. That write-back had exactly one caller (this one, in `buildRuntime`) and nothing reads it back — the control-plane UI serves the in-memory `config` object `buildRuntime` already holds. Removing it is what makes "split however you like" safe: Wake will never reorganize an operator's `config*.yaml` layout.

- [ ] **Step 1: Confirm the current pattern is identical at all 5 `loadWakeConfig` sites**

Run: `grep -n "configFile: stateStore.paths.configFile" src/main.ts`
Expected: 5 matches.

- [ ] **Step 2: Remove the `configFile` line from all 5 call sites**

Each looks like:

```ts
  const config = await loadWakeConfig({
    wakeRoot,
    configFile: stateStore.paths.configFile,
  });
```

Use a `replace_all` edit: find `\n    configFile: stateStore.paths.configFile,` (the line including its leading newline) and replace with empty string, at all 5 sites — indentation on the closing `});` line is unaffected either way since it's already on its own line. If your edit tool requires unique matches, do this one call site at a time using enough surrounding context (a few lines before/after) to disambiguate each of the 5.

- [ ] **Step 3: Remove the config write-back**

Find (around what was originally line 555, in `buildRuntime`):

```ts
  const config = await loadWakeConfig({
    wakeRoot,
  });
  await stateStore.writeConfig(config);
```

Replace with:

```ts
  const config = await loadWakeConfig({
    wakeRoot,
  });
```

This is the only one of the 5 `loadWakeConfig` call sites inside `buildRuntime` (the other 4 are in other CLI command handlers — `sandbox`, `doctor`, etc. — that never called `writeConfig` in the first place; leave them as-is beyond the Step 2 change).

- [ ] **Step 4: Build to confirm nothing else depended on the write-back**

Run: `npm run build`
Expected: succeeds. If it fails on `stateStore.writeConfig` being referenced somewhere else you haven't seen, stop and investigate before proceeding — this plan's earlier research (`grep -rn "writeConfig\b" src test`) found exactly one call site, but re-verify against your current tree.

- [ ] **Step 5: Run the full test suite to confirm no test relied on the write-back's side effect**

Run: `npx vitest run test/cli/build-runtime-pr-gating.test.ts`
Expected: PASS unchanged — this test's `writeConfig` helper (a local test function, unrelated to `stateStore.writeConfig`) writes directly to `config.json` before calling `buildRuntime`; it never asserted anything about post-tick file contents, so removing the write-back doesn't affect it. It continues to exercise the legacy `config.json` fallback path from Task 6.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write --end-of-line lf src/main.ts
npm run build
git add src/main.ts
git commit -m "Stop writing resolved config back to disk every tick"
```

---

### Task 10: Delete the now-dead `writeConfig` method from `state-store.ts`

**Files:**
- Modify: `src/adapters/fs/state-store.ts`

**Interfaces:**
- Removes: `writeConfig(record: WakeConfig): Promise<WakeConfig>` and its now-unused imports (`parseWakeConfig`, `WakeConfig`).

After Task 9, nothing calls `stateStore.writeConfig` — confirm with `grep -rn "writeConfig\b" src test` (only the method's own definition and its `writeJsonFile` internals should remain; if anything else still calls it, stop and reconsider this task rather than deleting a used method).

- [ ] **Step 1: Confirm no remaining callers**

Run: `grep -rn "\.writeConfig(" src test`
Expected: no matches (the method's definition itself doesn't match this pattern since it's `writeConfig(record...` not `.writeConfig(`).

- [ ] **Step 2: Delete the method**

In `src/adapters/fs/state-store.ts`, remove:

```ts
    async writeConfig(record: WakeConfig): Promise<WakeConfig> {
      const parsed = parseWakeConfig(record);
      await writeJsonFile(paths.configFile, parsed);
      return parsed;
    },
```

- [ ] **Step 3: Remove the now-unused imports**

Run: `grep -n "WakeConfig\b\|parseWakeConfig" src/adapters/fs/state-store.ts` — both should now only appear in the `import { ... } from '../../domain/schema.js'` / `'../../domain/types.js'` lines. Remove `parseWakeConfig` from the schema.js import list and `WakeConfig` from the types.js import list (don't remove the whole import statements if other named imports from those modules are still used elsewhere in the file — check first).

- [ ] **Step 4: Lint and build**

Run: `npx eslint src/adapters/fs/state-store.ts && npm run build`
Expected: no unused-import errors, clean build.

- [ ] **Step 5: Run the state-store test suite**

Run: `npx vitest run test/adapters/state-store.test.ts`
Expected: PASS — this file never had a `writeConfig` test (confirmed via `grep -n "writeConfig" test/adapters/state-store.test.ts` before this task), so nothing needs deleting there.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write --end-of-line lf src/adapters/fs/state-store.ts
git add src/adapters/fs/state-store.ts
git commit -m "Delete dead writeConfig — nothing calls it after removing tick-time write-back"
```

---

### Task 11: Update the sandbox health-check script

**Files:**
- Modify: `docker/log-command.sh:90`

- [ ] **Step 1: Edit the health check**

Find:

```sh
emit_check "wake-config" test -f "${container_mount}/config.json"
```

Replace with:

```sh
emit_check "wake-config" test -f "${container_mount}/config.yaml" -o -f "${container_mount}/config.json"
```

This accepts either the new default layout or a not-yet-split legacy Wake home as healthy.

- [ ] **Step 2: Verify the script is still valid shell**

Run: `bash -n docker/log-command.sh`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add docker/log-command.sh
git commit -m "Accept config.yaml or legacy config.json in the sandbox health check"
```

---

### Task 12: Rewrite `docs/configuration.md`

**Files:**
- Modify: `docs/configuration.md`

- [ ] **Step 1: Replace the intro (original lines 1-20)**

Replace:

```markdown
# Configuration

Wake's behavior is configured through a `config.json` file at the root of a
Wake home directory (see [docs/getting-started.md](getting-started.md)).
This document describes the configuration structure, properties, and
defaults.

## Overview

The configuration file defines:

- Where Wake stores runtime data and state
- How the Docker sandbox is mounted and debugged
- How frequently the control plane checks for new work
- Which execution mode and CLI settings to use
- Which external sources (like GitHub) to monitor for work
- Policies for filtering and publishing work

All configuration uses `schemaVersion: 1`.
```

with:

```markdown
# Configuration

Wake's behavior is configured through YAML files at the root of a Wake home
directory (see [docs/getting-started.md](getting-started.md)). Wake reads
**every file matching `config.yaml` or `config.<label>.yaml`** in that
directory and deep-merges them together — nested objects merge key by key,
arrays and scalars are replaced wholesale by whichever file sets them last.
Files are merged in alphabetical order by filename, so a later-sorting file
wins on any key both files set. There's no required layout: split
configuration into as many or as few files as you want.

`wake init` scaffolds a default two-file split:

- **`config.yaml`** — infra/operational settings: storage paths, Docker
  sandbox mounting, scheduler timing, transcripts, the control-plane UI, and
  which external sources (like GitHub) to monitor.
- **`config.workflows.yaml`** — behavior/policy settings: the runner
  registry, capability tiers, workflow and stage definitions, custom
  commands, and per-stage routing. These are kept together by default
  because they reference each other by name — a stage route names a `tier`,
  a tier names `runners`, a workflow selector names a `workflow` — but
  nothing stops you from splitting further, e.g. a standalone
  `config.sources.yaml` for GitHub polling settings.

Any field left unset in every file falls back to a built-in default.
`config.yaml` carries `schemaVersion: 1`.
```

- [ ] **Step 2: Replace the "Full Sample Configuration" section (through the closing fence, roughly the original lines 21-127)**

Split it into two fenced YAML samples matching the default two-file layout — keep every field and value the old combined JSON sample had, reshaped as YAML and partitioned by the Task 2 key split:

````markdown
## Full Sample Configuration

`config.yaml`:

```yaml
schemaVersion: 1
paths:
  wakeRoot: /path/to/wake-home
  promptsRoot: /path/to/wake-home/prompts
sandbox:
  image: wake-sandbox
  imageRepository: wake-sandbox
  containerName: wake-sandbox-my-project
  containerMountPath: /wake
  containerHomeMountPath: /home/wake
  start:
    enabled: true
  extraMounts: []
scheduler:
  intervalMs: 60000
  maxIntervalMs: 300000
transcripts:
  enabled: false
  retainAfterWorkspaceCleanup: false
ui:
  enabled: false
  port: 4317
  tunnel:
    enabled: false
sources:
  github:
    enabled: false
    repos: []
    polling:
      maxIssuesPerRepo: 25
      commentPageSize: 25
      lookbackMs: 60000
    policy:
      requiredLabels: []
      ignoredLabels: []
      requiredAssignees: []
    publication:
      postStatusComments: true
    pullRequests:
      enabled: false
      maxPullRequestsPerRepo: 25
      commentPageSize: 25
      policy:
        requiredAuthors: []
```

`config.workflows.yaml`:

```yaml
runners:
  fake:
    kind: fake
  claude-haiku:
    kind: claude
    command: claude
    model: claude-haiku-4-5
    timeoutMs: 600000
  claude-opus:
    kind: claude
    command: claude
    model: claude-opus-4-8
    timeoutMs: 1800000
  codex-standard:
    kind: codex
    command: codex
    model: gpt-5.4
    timeoutMs: 1200000
    reasoningEffort: medium
  codex-flagship:
    kind: codex
    command: codex
    model: gpt-5.5
    timeoutMs: 1800000
    reasoningEffort: high
  cursor-composer:
    kind: cursor
    command: cursor
    model: composer-2.5
    timeoutMs: 1800000
tiers:
  light: [claude-haiku]
  standard: [codex-standard, claude-haiku]
  deep: [claude-opus, codex-flagship]
defaultTier: standard
stages:
  queue:
    action: refine
    tier: light
  implement:
    action: implement
    tier: standard
```
````

- [ ] **Step 3: Add a "Splitting further" subsection right after the sample**

```markdown
### Splitting further

Any file named `config.yaml` or `config.<label>.yaml` in the Wake home root
is read and merged. For example, to keep GitHub polling settings separate
from the rest of `config.yaml`:

`config.sources.yaml`:

```yaml
sources:
  github:
    enabled: true
    repos: [owner/repo]
```

Wake merges this with whatever `config.yaml` also sets under `sources` —
merging is recursive, not a whole-file override, so `config.yaml` can leave
`sources` out entirely and this file is the only place it's set, or both
files can set different sub-fields of `sources.github` and both take
effect. Wake never rewrites these files — whatever split you create is the
split that persists.
```

- [ ] **Step 4: Update the `sandbox` section's inline JSON examples**

The `sandbox` section (original lines 190-326) has several standalone JSON snippets showing `extraMounts` configuration (for Claude, Codex, and Cursor credentials). Each currently looks like:

```json
{
  "schemaVersion": 1,
  "sandbox": {
    "extraMounts": [
      {
        "source": "C:/Users/alice/.claude/.credentials.json",
        "target": "/home/wake/.claude/.credentials.json",
        "readOnly": true
      },
      {
        "source": "C:/Users/alice/.claude/settings.json",
        "target": "/home/wake/.claude/settings.json",
        "readOnly": true
      }
    ]
  }
}
```

Convert each of the 3 fenced ` ```json ` blocks in this section to ` ```yaml `, e.g. the one above becomes:

```yaml
schemaVersion: 1
sandbox:
  extraMounts:
    - source: C:/Users/alice/.claude/.credentials.json
      target: /home/wake/.claude/.credentials.json
      readOnly: true
    - source: C:/Users/alice/.claude/settings.json
      target: /home/wake/.claude/settings.json
      readOnly: true
```

Apply the same object-list-to-YAML-sequence conversion to the Codex and Cursor `extraMounts` examples immediately below it. Also update the prose mention "To avoid storing the token in `config.json`" (near the `tunnel.authToken` bullet) to say `config.yaml`.

- [ ] **Step 5: Update the `commands` section's JSON example**

Replace:

```json
"commands": {
  "ask": {
    "action": "ask",
    "workspace": "read-only",
    "tier": "light"
  },
  "codereview": {
    "action": "codereview",
    "workspace": "read-only",
    "tier": "standard"
  }
}
```

with (fence changed to ` ```yaml `):

```yaml
commands:
  ask:
    action: ask
    workspace: read-only
    tier: light
  codereview:
    action: codereview
    workspace: read-only
    tier: standard
```

- [ ] **Step 6: Update the `ui` section's JSON example**

Replace:

```json
"ui": {
  "enabled": false,
  "port": 4317,
  "token": null,
  "tunnel": {
    "enabled": false,
    "authToken": null
  }
}
```

with:

```yaml
ui:
  enabled: false
  port: 4317
  token: null
  tunnel:
    enabled: false
    authToken: null
```

- [ ] **Step 7: Update the final "enable GitHub polling" example**

Replace:

```json
{
  "schemaVersion": 1,
  "sources": {
    "github": {
      "enabled": true,
      "repos": ["owner/repo"]
    }
  }
}
```

with:

```yaml
schemaVersion: 1
sources:
  github:
    enabled: true
    repos: [owner/repo]
```

- [ ] **Step 8: Rewrite "Loading and Merging"**

Replace:

```markdown
## Loading and Merging

Wake loads configuration from `.wake/config.json` relative to the current working directory. If the file does not exist, Wake uses built-in defaults. Configuration is merged with defaults, so you only need to specify the properties you want to override.
```

with:

```markdown
## Loading and Merging

Wake loads every `config.yaml`/`config.<label>.yaml` file from the Wake
home root (not `.wake/` — that hidden directory is durable runtime state,
not configuration) and deep-merges them in alphabetical filename order.
Missing fields fall back to built-in defaults.

Wake homes created before this file-splitting existed still have a single
combined `config.json`. Wake reads it directly whenever no `config*.yaml`
file is present — no migration step, and Wake never rewrites or renames it.
Once you add a `config.yaml` (by running `wake init` fresh, or by hand),
`config.json` is ignored.

Wake does not write resolved configuration back to disk. What's on disk is
exactly what you put there (plus schema defaults applied in memory) — there
is no tick-time normalization step to work around when hand-splitting files.
```

Leave the rest of the "Loading and Merging" section (sandbox debugging / `wake sandbox logs` / upgrade instructions) as-is — only the section above changed.

- [ ] **Step 9: Add a short annotation to each `## Configuration Sections` subsection heading**

For each `###` subsection under `## Configuration Sections`, add one italic line right after the heading naming which default file it lives in, e.g.:

```markdown
### paths

_Lives in `config.yaml`._

Runtime and storage directories.
```

Apply to all subsections per the Task 2 key split: `paths`, `sandbox`, `transcripts`, `scheduler`, `ui`, `sources.github` → `config.yaml`; `commands`, `runners`, `tiers`, `defaultTier`, `stages` → `config.workflows.yaml`. `wake correlate` isn't a config section (it's a CLI command documented separately) — skip it.

- [ ] **Step 10: Proofread the whole file**

Read the full rewritten `docs/configuration.md` top to bottom. Confirm no remaining `config.json` mentions except the intentional legacy-fallback paragraph from Step 8, no remaining ` ```json ` fences describing Wake config, and every YAML sample would actually parse (check indentation consistency).

- [ ] **Step 11: Commit**

```bash
git add docs/configuration.md
git commit -m "Rewrite docs/configuration.md for the config*.yaml glob-merge split"
```

---

### Task 13: Update remaining `config.json` mentions across the docs

**Files:**
- Modify: `README.md`, `docs/workflows.md`, `docs/getting-started.md`, `docs/development.md`, `docs/architecture.md`, `docs/design/implementation.md`, `docs/specs/control-plane-ui.md`, `docs/runner-comparison.md`

Re-run `grep -rn "config\.json" README.md docs/workflows.md docs/getting-started.md docs/development.md docs/design/implementation.md docs/architecture.md docs/specs/control-plane-ui.md docs/runner-comparison.md` first — line numbers may have drifted since this plan was written — then apply the following edits by content match.

- [ ] **Step 1: `README.md`**

Replace:

```markdown
  directory: `config.json`, `prompts/`, and `workspaces/` at the top level for
```

with:

```markdown
  directory: `config.yaml`, `config.workflows.yaml`, `prompts/`, and `workspaces/` at the top level for
```

Replace:

```markdown
- [docs/configuration.md](docs/configuration.md) — `config.json` options and the operator correlation escape hatch.
```

with:

```markdown
- [docs/configuration.md](docs/configuration.md) — `config.yaml`/`config.workflows.yaml` options and the operator correlation escape hatch.
```

- [ ] **Step 2: `docs/workflows.md`**

Read the full paragraph around the `config.json` mention (near line 11) and update it to say `config.workflows.yaml` (workflow definitions live there post-split) — check the sentence still reads naturally after the substitution rather than doing a blind swap.

- [ ] **Step 3: `docs/getting-started.md`**

Three mentions:
- `` `config.json`, `prompts/`, `workspaces/`, and a hidden `.wake/` for durable `` → `` `config.yaml`, `config.workflows.yaml`, `prompts/`, `workspaces/`, and a hidden `.wake/` for durable ``
- `` `wake init` scaffolds `config.json`, `prompts/`, and `workspaces/`. It does `` → `` `wake init` scaffolds `config.yaml`, `config.workflows.yaml`, `prompts/`, and `workspaces/`. It does ``
- The directory-tree code block (around line 83) — read it first to match its exact comment-column spacing, then change `config.json         # edit this` to two lines: `config.yaml          # infra/sandbox/sources — edit this` and `config.workflows.yaml # runners/tiers/workflows — edit this`.

- [ ] **Step 4: `docs/development.md`**

Three mentions (around lines 62, 106, 110). Read each surrounding sentence — most describe the scaffolded dev Wake home's config file in a paths/sandbox context, so `config.json` → `config.yaml` is likely right, but verify against the actual field mentioned in each sentence and use `config.workflows.yaml` instead if that field is workflow-shaped.

- [ ] **Step 5: `docs/architecture.md`**

Two mentions:
- `` Wake owns a Wake home directory (`config.json`, `prompts/`, `workspaces/` at `` → `` Wake owns a Wake home directory (`config.yaml`, `config.workflows.yaml`, `prompts/`, `workspaces/` at ``
- `` - `config.json` for versioned config `` → `` - `config.yaml`/`config.workflows.yaml` for versioned config ``

- [ ] **Step 6: `docs/design/implementation.md`**

One mention (around line 317), inside a directory-tree sketch: `` config.json           # timing, quiet hours, models, repo allowlist, caps ``. Check whether "quiet hours" is a real current config field per the rewritten `docs/configuration.md` — if not, that's a pre-existing inaccuracy; drop the phrase rather than propagate it. Replace with two lines matching the tree's comment style:

```
config.yaml             # timing, sandbox, repo allowlist, caps
config.workflows.yaml   # models, runners, tiers, stage routing
```

- [ ] **Step 7: `docs/specs/control-plane-ui.md`**

Three mentions: a table row `` | Config | `config.json` | Config view, routing table, policy display | `` → change the cell to `` `config.yaml` / `config.workflows.yaml` ``; a redaction note ("no secrets currently live in `config.json`") → `` `config.yaml`/`config.workflows.yaml` ``; a non-mutation note ("operators edit `config.json`") → `` operators edit `config.yaml`/`config.workflows.yaml` (or any `config.*.yaml` split they've made) ``.

- [ ] **Step 8: `docs/runner-comparison.md`**

One mention: `` Example `config.json` extraMounts for all three: `` → `` Example `config.yaml` extraMounts for all three: ``.

- [ ] **Step 9: Re-run the grep to confirm nothing was missed**

Run: `grep -rn "config\.json" README.md docs/ --include=*.md | grep -v "docs/superpowers/\|docs/plans/\|docs/reports/\|docs/vision-inputs/\|docs/handoffs/\|docs/adrs/"`

Expected: only `docs/configuration.md`'s one intentional legacy-fallback paragraph from Task 12 Step 8.

- [ ] **Step 10: Commit**

```bash
git add README.md docs/workflows.md docs/getting-started.md docs/development.md docs/architecture.md docs/design/implementation.md docs/specs/control-plane-ui.md docs/runner-comparison.md
git commit -m "Update remaining docs for the config*.yaml glob-merge split"
```

---

### Task 14: Full verification and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: lint, format:check, build, and all tests pass. If `format:check` flags files you didn't touch, confirm via `git status` that they're pre-existing CRLF false positives (per Global Constraints).

- [ ] **Step 2: Manual smoke — fresh `wake init`**

```bash
cd bin && npm link && cd ..
mkdir -p /tmp/wake-config-split-smoke
wake-dev init /tmp/wake-config-split-smoke/wake-home
ls /tmp/wake-config-split-smoke/wake-home
cat /tmp/wake-config-split-smoke/wake-home/config.yaml
cat /tmp/wake-config-split-smoke/wake-home/config.workflows.yaml
```

Expected: both files exist, no `config.json`; `config.yaml` contains `sandbox:`/`paths:`/`dev:` etc; `config.workflows.yaml` contains `runners:`/`tiers:`/`workflows:` etc.

- [ ] **Step 3: Manual smoke — a tick against the fresh home**

```bash
wake-dev tick --wake-root /tmp/wake-config-split-smoke/wake-home
ls /tmp/wake-config-split-smoke/wake-home
```

Expected: tick completes without a config-parsing error, and — this is the behavior change from Task 9 — the file listing is unchanged after the tick (no new/rewritten config file appears; Wake didn't touch it).

- [ ] **Step 4: Manual smoke — splitting further by hand**

```bash
cat > /tmp/wake-config-split-smoke/wake-home/config.sources.yaml <<'EOF'
sources:
  github:
    enabled: false
    repos: []
EOF
wake-dev tick --wake-root /tmp/wake-config-split-smoke/wake-home
```

Expected: tick still completes cleanly with a third `config*.yaml` file present, proving the merge picks up an arbitrary extra file with no code change.

- [ ] **Step 5: Manual smoke — legacy config.json still works standalone**

```bash
mkdir -p /tmp/wake-config-split-smoke/legacy-home
echo '{"schemaVersion":1}' > /tmp/wake-config-split-smoke/legacy-home/config.json
wake-dev tick --wake-root /tmp/wake-config-split-smoke/legacy-home
ls /tmp/wake-config-split-smoke/legacy-home
```

Expected: tick completes; `config.json` is still the only config file afterward (not renamed, not supplemented) — confirms Wake never touches it.

- [ ] **Step 6: Clean up**

```bash
rm -rf /tmp/wake-config-split-smoke
```

- [ ] **Step 7: Report status**

Summarize: all tasks committed, `npm run verify` green, manual smoke test (init → tick → hand-split → legacy standalone) confirmed. No further action needed unless the user wants this pushed / opened as a PR.

---

### Task 15: Migrate the operator's real `~/wake-home` from `config.json` to the split YAML files

**Files:** none in this repo — this task operates on `~/wake-home` (the operator's actual, currently-running Wake deployment, outside this git checkout), not on `wake` source.

This is a real, currently-used Wake home (Docker sandbox on the operator's laptop, per the project's autonomy-mission context), not a test fixture — treat it with the same care as any production config change: read before writing, don't delete the original, and report exactly what changed.

- [ ] **Step 1: Read the current `~/wake-home/config.json` in full**

Read the whole file. Do not assume its shape matches the sample in `docs/configuration.md` — this file may have operator-specific values (custom `sandbox.extraMounts`, `runners`, `tiers`, GitHub `repos`, etc.) that must be carried over exactly, not replaced with defaults.

- [ ] **Step 2: Partition the file's top-level keys using the same split as the rest of this plan**

Infra keys (→ `config.yaml`): `schemaVersion`, `paths`, `sandbox`, `dev`, `scheduler`, `transcripts`, `ui`, `sources`, `sinks`.
Workflow keys (→ `config.workflows.yaml`): `runners`, `tiers`, `defaultTier`, `workflows`, `workflowSelectors`, `commands`, `stages`.

This is the exact same partition `wakeInfraConfigSchema`/`wakeWorkflowConfigSchema` encode in `src/domain/schema.ts` (Task 2) — every key in the operator's `config.json` should land in exactly one of the two new files, with no key dropped and no value altered (just reformatted from JSON to YAML).

- [ ] **Step 3: Write `~/wake-home/config.yaml` and `~/wake-home/config.workflows.yaml`**

Write both files as valid YAML with the partitioned content from Step 2. Preserve every value exactly (paths, tokens-shaped strings, arrays, nested objects) — this is a format conversion, not a content edit. Double-check any Windows-style paths in `sandbox.extraMounts` (e.g. `C:/Users/...`) round-trip correctly as YAML plain scalars (they should — no escaping needed, unlike the JSON originals which used `\\` for backslashes if any existed).

- [ ] **Step 4: Verify both files parse correctly and match the original**

Read both new files back, parse them as YAML, and diff the resulting merged object against the original `config.json` parsed as JSON — they must be structurally identical (same keys, same values, just JSON vs. YAML source). Do not proceed to Step 5 until this check passes.

- [ ] **Step 5: Do not delete or modify the original `config.json`**

Leave `~/wake-home/config.json` in place, untouched. Per this plan's design (Task 6/Task 9), Wake will now read `config.yaml`/`config.workflows.yaml` instead (since at least one `config*.yaml` file now exists, the legacy `config.json` fallback path is bypassed and the file becomes inert) — but deleting it isn't necessary and removes a trivial rollback option for the operator at no benefit.

- [ ] **Step 6: Report to the operator**

State plainly: `config.yaml` and `config.workflows.yaml` were created in `~/wake-home` with the same effective configuration as the existing `config.json`; the old `config.json` is left in place but is no longer read (Wake now merges `config*.yaml` files instead, per Task 6). Mention that the running sandbox does not need to be rebuilt for this alone — these are host-side wake-home files read by whatever `wake` binary the container runs — but the container does need to be running an image built from this branch's code (post-merge, after Task 14) for the new loading behavior to actually apply; until then, the container's currently-running Wake binary still expects `config.json` and the operator's setup keeps working unchanged either way (the legacy fallback means both file layouts work simultaneously during the transition).
