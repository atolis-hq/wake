# Wake Target Architecture Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wake's emergent implementation with the approved
event-driven, domain-modular architecture without silently losing valid
capabilities or learned operational constraints.

**Architecture:** Build the target beside the legacy implementation under
`src-next` and `test-next`, beginning with a thin end-to-end spine and then
adding vertical capability slices. The target owns specialist Work, Resources,
Orchestration, Activities, Execution, Control Plane, Integration, Persistence,
and Surface modules over one append-only event journal; legacy code is
evidence only and cannot be imported by target code.

**Tech Stack:** Node.js 24+, TypeScript 6, Zod 4, Vitest 4, YAML, ULID,
dependency-cruiser, ESLint/typescript-eslint, Knip, append-only JSONL storage,
GitHub/Octokit adapters.

---

## 1. Execution contract

Read
[`docs/superpowers/specs/2026-07-30-wake-target-architecture-design.md`](../specs/2026-07-30-wake-target-architecture-design.md)
before starting. That design and each target module's contracts are
authoritative. Use legacy code, tests, documentation, and issues only as
evidence.

Execute tasks in order on one rewrite branch. A dedicated worktree is
recommended, but there is only one implementation branch and no staged
production migration.

For every task:

1. Start from a clean worktree.
2. Write or port the named failing test first.
3. Run the narrow test and confirm the expected failure reason.
4. Implement only what the task requires.
5. Run the narrow test, `npm run verify:next`, and the listed legacy regression
   command.
6. Update functional-decision rows and scenario links affected by the task.
7. Commit the task before starting another.

Hard rules:

- Never import `src/**` from `src-next/**` or `test/**` from `test-next/**`.
- Do not edit legacy domain shapes to make target implementation easier.
- Copy a legacy technical component only into its final target owner and only
  after its accepted tests have been ported.
- Do not reproduce behaviour marked `correct`, `consolidate`, or `remove`.
- Do not create or change a `correct`, `consolidate`, `remove`, or `defer`
  disposition without operator or designated architecture-review approval.
- Do not weaken an E2E assertion to match implementation output.
- Do not add snapshots, upcasters, workflow-version entities, general graph
  mutation, work dependency semantics, or parallel workflow positions.
- Do not advance past a work-packet gate with a failing architecture,
  catalogue, or scenario check.

## 2. Work-packet order and gates

| Packet | Tasks | Gate |
| --- | --- | --- |
| A. Evidence and guardrails | 1-3 | Legacy evidence frozen; all module manifests and import rules pass |
| B. Minimal domain spine | 4-12 | One WorkItem reaches workflow completion through real target modules and fake boundaries |
| C. Durable operation | 13-18 | Filesystem replay, persisted projections, waits, retries, child workflows, and external-input scenarios pass |
| D. Specialist SDLC safety | 19-21 | Revision-bound approval/merge and ambiguous external-effect scenarios pass |
| E. Hosts and product surfaces | 22-26 | Cancellation/recovery, tick, resident, schedule, config, CLI, API, UI, and operational command decisions pass |
| F. Audit and cutover | 27-29 | Catalogue is complete, full verification passes, legacy is removed |

The plan deliberately builds only enough of each module to complete the first
golden path, then expands by capability. Do not finish an entire technical
layer before running the E2E spine.

## 3. Target file map

This map fixes ownership. Add smaller files inside the listed areas when a file
would otherwise exceed the target complexity limits; do not create another
top-level module.

```text
src-next/
  main.ts
  kernel/
    MODULE.md
    module.json
    index.ts
    contracts/{checkpoint-store,clock,commands,event-journal,events,id-generator,identifiers,projection-store,relations}.ts
    domain/{event-envelope,relation}.ts
    infrastructure/{system-clock,ulid-id-generator}.ts
  persistence/
    MODULE.md
    module.json
    index.ts
    application/projection-runner.ts
    filesystem/{file-checkpoint-store,file-event-journal,file-lock,file-projection-store}.ts
    memory/in-memory-event-journal.ts
  work/
    MODULE.md
    module.json
    index.ts
    contracts/{commands,config,events,identifiers,views}.ts
    domain/work-item.ts
    application/{work-repository,work-service}.ts
  resources/
    MODULE.md
    module.json
    index.ts
    contracts/{commands,config,events,identifiers,views}.ts
    domain/{correlation,resource}.ts
    application/{resource-repository,resource-service}.ts
  activities/
    MODULE.md
    module.json
    index.ts
    contracts/{activity,config,events,registry}.ts
    agent/{agent-activity,agent-result}.ts
    pr/{contracts,approve,merge,policy}.ts
    review/{contracts,signals}.ts
  orchestration/
    MODULE.md
    module.json
    index.ts
    contracts/{commands,config,events,identifiers,views}.ts
    domain/{compiler,interpreter,workflow-instance}.ts
    application/{orchestration-repository,orchestration-service,watch-reactor}.ts
  execution/
    MODULE.md
    module.json
    index.ts
    contracts/{config,events,runner,views,workspace}.ts
    domain/{run,run-result}.ts
    application/{execution-service,recovery-service,run-repository}.ts
    infrastructure/
      runners/{claude,codex,cursor,fake,registry}.ts
      workspace/{fake-workspace,git-workspace}.ts
      {process-execution,transcripts}.ts
  control-plane/
    MODULE.md
    module.json
    index.ts
    contracts/{commands,config,views}.ts
    domain/{dispatch-policy,schedule-policy}.ts
    application/{advance-once,control-plane-service,schedule-service}.ts
    infrastructure/{resident-host,tick-host}.ts
  integrations/
    MODULE.md
    module.json
    index.ts
    delivery/
      contracts/{commands,config,events,views}.ts
      application/{delivery-projector,delivery-service}.ts
    github/
      contracts/{config,events,payloads}.ts
      application/{inbound-translator,outbound-translator,poll-service}.ts
      infrastructure/{client,etag-cache,issue-source,pr-source,delivery}.ts
    fake/{external-source,external-sink}.ts
  surfaces/
    MODULE.md
    module.json
    index.ts
    cli/{main,usage}.ts
    cli/commands/
    api/
      contracts/
      presenters/
      routes/
      {http-server,problem-details,router}.ts
    web-host/{asset-source,packaged-assets}.ts
    web/
      package.json
      tsconfig.json
      {vite.config,vitest.config,playwright.config}.ts
      index.html
      src/
      test/
      e2e/
  bootstrap/
    MODULE.md
    module.json
    index.ts
    config/{load-config,root-schema}.ts
    {composition-root,paths}.ts

test-next/
  architecture/
  kernel/
  persistence/
  work/
  resources/
  activities/
  orchestration/
  execution/
  control-plane/
  integrations/
  surfaces/
  bootstrap/
  e2e/
    scenarios/
    support/{faults,scenario,trace,world}.ts
```

## 4. Design-to-plan coverage

| Design sections | Implementing tasks |
| --- | --- |
| 1-4: decision, goals, principles, legacy authority | 1-3, 27 |
| 5: foundational model | 4, 6-11, 19 |
| 6: bounded contexts and dependencies | 3, 24, 28 |
| 7: workflow orchestration | 9-10, 17-18 |
| 8: Activities and specialist SDLC behaviour | 8, 16, 19-20 |
| 9: Execution | 11, 16, 22 |
| 10: events, `.wake` persistence, projections, delivery | 4, 13-15, 21 |
| 11: control-plane hosts | 12, 18, 23 |
| 12: configuration and API ownership | 9, 11, 24-25 |
| 13-14: module specifications and guardrails | 3, 27 |
| 15: testing strategy | 5, 7, 12-23, 27 |
| 16-17: catalogue and replacement method | 1, 27-28 |
| 18: immediate priorities | 12-23 |
| 19: issues and advisory lessons | 1, 14-27 |
| 20: success criteria | 27-29 |

## Task 1: Freeze capability evidence and create the decision catalogue

**Files:**

- Create: `docs/architecture/legacy-test-evidence.txt`
- Create: `docs/architecture/legacy-surface-evidence.txt`
- Create: `docs/architecture/functional-decision-catalogue.md`
- Create: `scripts/check-functional-catalogue.mjs`
- Modify: `package.json`

- [ ] **Step 1: Record the legacy verification baseline**

Run:

```powershell
npm run verify
```

Expected: PASS. Record any pre-existing failure in the catalogue introduction
with the exact command and output; do not repair it as part of this task.

- [ ] **Step 2: Freeze the test and surface evidence lists**

Run:

```powershell
rg --files test -g '*.test.ts' |
  ForEach-Object { $_ -replace '\\', '/' } |
  Sort-Object |
  Set-Content -Encoding utf8 docs/architecture/legacy-test-evidence.txt
$wakeSurfaceEvidence = @(
  'package.json'
  'README.md'
  'src/main.ts'
  'src/domain/schema.ts'
  'docs/configuration.md'
  'docs/workflows.md'
  'docs/events.md'
  'docs/execution-invariants.md'
  'docs/cli.md'
) + @(rg --files bin docker prompts templates)
$wakeSurfaceEvidence |
  Where-Object { Test-Path $_ } |
  ForEach-Object { $_ -replace '\\', '/' } |
  Sort-Object -Unique |
  Set-Content -Encoding utf8 docs/architecture/legacy-surface-evidence.txt
```

Expected: the first file contains every current `*.test.ts` path exactly once;
the second contains every listed path that exists.

- [ ] **Step 3: Write the catalogue using the enforced row format**

Create the document with these columns:

```markdown
# Wake Functional Decision Catalogue

The catalogue records disposition of legacy capability evidence. It does not
define target architecture. Authority order is the target design, MODULE.md,
public contracts, target scenarios, target code, this catalogue, then legacy
evidence.

| ID | Intent or learned constraint | Underlying mechanic | Disposition | Target owner | Target scenarios | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| WORK-INTAKE-001 | Eligible external work can become Wake-owned work exactly once | Wake identity is independent of the external resource and intake is idempotent | correct | work, resources, integrations | E2E-WORK-001, E2E-WORK-002 | `test/core/tick-runner.intake.test.ts`; `test/core/event-resolver.test.ts` |
```

Use only these dispositions:

- `preserve`: accepted semantics remain observably equivalent;
- `correct`: preserve intent but replace known-invalid semantics;
- `consolidate`: several paths become one target mechanic;
- `remove`: invalid or unwanted intent is explicitly deleted;
- `defer`: valid future capability excluded by the approved design.

Create rows for these capability families before subdividing variants:

```text
WORK-INTAKE, WORK-LIFECYCLE, WORK-COMMAND
RESOURCE-IDENTITY, RESOURCE-CORRELATION, RESOURCE-CONFLICT
ORCH-CONFIG, ORCH-TRANSITION, ORCH-WAIT, ORCH-CHILD, ORCH-WATCH
EXEC-RUN, EXEC-RESULT, EXEC-ROUTING, EXEC-WORKSPACE, EXEC-CANCEL, EXEC-RECOVERY
ACT-AGENT, ACT-REVIEW, ACT-PR-APPROVE, ACT-PR-MERGE
CONTROL-TICK, CONTROL-RESIDENT, CONTROL-SCHEDULE, CONTROL-FAIRNESS, CONTROL-QUOTA
INT-GITHUB-ISSUE, INT-GITHUB-PR, INT-HUMAN-SIGNAL, INT-PUBLISH, INT-OUTBOX
SURFACE-CLI, SURFACE-API, SURFACE-UI, OPS-INIT, OPS-DOCTOR, OPS-SANDBOX,
OPS-SELF-UPDATE, OPS-TRANSCRIPT
```

Every line in both evidence files must appear in at least one catalogue
`Evidence` cell. A row with disposition `preserve`, `correct`, or `consolidate`
must name at least one target scenario ID. `remove` and `defer` rows must state
the reason in the intent/constraint cell.

- [ ] **Step 4: Add a deterministic catalogue checker**

Create `scripts/check-functional-catalogue.mjs`:

```js
import { readFile } from 'node:fs/promises';

const cataloguePath = 'docs/architecture/functional-decision-catalogue.md';
const evidencePaths = [
  'docs/architecture/legacy-test-evidence.txt',
  'docs/architecture/legacy-surface-evidence.txt',
];
const allowed = new Set(['preserve', 'correct', 'consolidate', 'remove', 'defer']);
const catalogue = await readFile(cataloguePath, 'utf8');
const failures = [];
const ids = new Set();

for (const line of catalogue.split(/\r?\n/)) {
  if (!line.startsWith('| ') || line.startsWith('| ID ') || line.startsWith('| ---')) continue;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  if (cells.length !== 7) {
    failures.push(`Catalogue row must contain 7 cells: ${line}`);
    continue;
  }
  const [id, intent, mechanic, disposition, owner, scenarios, evidence] = cells;
  if (!id || ids.has(id)) failures.push(`Missing or duplicate ID: ${id}`);
  ids.add(id);
  if (!intent || !mechanic || !owner || !evidence) failures.push(`Incomplete row: ${id}`);
  if (!allowed.has(disposition)) failures.push(`Invalid disposition for ${id}: ${disposition}`);
  if (
    ['preserve', 'correct', 'consolidate'].includes(disposition) &&
    !/^E2E-[A-Z0-9-]+(?:,\s*E2E-[A-Z0-9-]+)*$/.test(scenarios)
  ) {
    failures.push(`Target scenarios required for ${id}`);
  }
}

for (const evidencePath of evidencePaths) {
  const evidence = (await readFile(evidencePath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, '').trim())
    .filter(Boolean);
  for (const path of evidence) {
    if (!catalogue.includes(`\`${path}\``)) failures.push(`Uncatalogued evidence: ${path}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Catalogue valid: ${ids.size} decisions\n`);
}
```

- [ ] **Step 5: Add and run the catalogue command**

Add to `package.json`:

```json
"check:catalogue": "node scripts/check-functional-catalogue.mjs"
```

Run:

```powershell
npm run check:catalogue
```

Expected: `Catalogue valid: <non-zero> decisions`.

- [ ] **Step 6: Obtain one catalogue disposition review**

Present the grouped `correct`, `consolidate`, `remove`, and `defer` rows to the
operator or designated architecture reviewer. Resolve comments in the
catalogue and record:

```markdown
**Disposition review:** Approved YYYY-MM-DD by <reviewer>
```

Do not start target implementation while this line is absent. Later changes to
these dispositions require a new dated review line.

- [ ] **Step 7: Commit the evidence baseline**

```powershell
git add docs/architecture scripts/check-functional-catalogue.mjs package.json
git commit -m "docs: catalogue Wake capability decisions"
```

## Task 2: Create the isolated target build and test lane

**Files:**

- Create: `tsconfig.next.json`
- Create: `vitest.next.config.ts`
- Create: `test-next/architecture/build-lane.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the target-lane smoke test**

Create `test-next/architecture/build-lane.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('target build lane', () => {
  it('runs independently from legacy tests', () => {
    expect('src-next').not.toBe('src');
  });
});
```

- [ ] **Step 2: Run the test before the lane exists**

Run:

```powershell
npx vitest run --config vitest.next.config.ts
```

Expected: FAIL because `vitest.next.config.ts` does not exist.

- [ ] **Step 3: Add isolated TypeScript and Vitest configuration**

Create `tsconfig.next.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist-next",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": [
    "src-next/**/*.ts",
    "test-next/**/*.ts",
    "vitest.next.config.ts"
  ],
  "exclude": ["src/**", "test/**", "dist/**", "dist-next/**"]
}
```

Create `vitest.next.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-next/**/*.test.ts'],
    sequence: { concurrent: false },
  },
});
```

- [ ] **Step 4: Install the approved OSS guardrail tools**

Run:

```powershell
npm install --save-dev dependency-cruiser knip
```

Expected: `package.json` and `package-lock.json` contain both dev dependencies.

- [ ] **Step 5: Add target scripts**

Add these `package.json` scripts:

```json
"build:next": "tsc -p tsconfig.next.json",
"test:next": "vitest run --config vitest.next.config.ts",
"verify:next": "npm run check:catalogue && npm run lint:architecture && npm run lint && npm run format:check && npm run build:next && npm run test:next",
"knip:next": "knip --config knip.next.json"
```

Leave the legacy `build`, `test`, and `verify` scripts unchanged.

- [ ] **Step 6: Run the isolated lane**

Run:

```powershell
npm run build:next
npm run test:next
npm test
```

Expected: target build and one target test PASS; the complete legacy test suite
still PASSes.

- [ ] **Step 7: Commit the lane**

```powershell
git add package.json package-lock.json tsconfig.next.json vitest.next.config.ts test-next
git commit -m "build: add isolated target architecture lane"
```

## Task 3: Scaffold modules and enforce dependency boundaries

**Files:**

- Create: `src-next/{kernel,persistence,work,resources,activities,orchestration,execution,control-plane,integrations,surfaces,bootstrap}/MODULE.md`
- Create: `src-next/{kernel,persistence,work,resources,activities,orchestration,execution,control-plane,integrations,surfaces,bootstrap}/module.json`
- Create: `src-next/{kernel,persistence,work,resources,activities,orchestration,execution,control-plane,integrations,surfaces,bootstrap}/index.ts`
- Create: `dependency-cruiser.config.mjs`
- Create: `knip.next.json`
- Create: `scripts/check-module-manifests.mjs`
- Create: `test-next/architecture/module-manifests.test.ts`
- Modify: `eslint.config.js`
- Modify: `package.json`

- [ ] **Step 1: Write the manifest architecture test**

Create `test-next/architecture/module-manifests.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const modules = [
  'kernel',
  'persistence',
  'work',
  'resources',
  'activities',
  'orchestration',
  'execution',
  'control-plane',
  'integrations',
  'surfaces',
  'bootstrap',
] as const;

describe('module manifests', () => {
  it.each(modules)('%s has matching human and machine contracts', async (name) => {
    const manifest = JSON.parse(
      await readFile(`src-next/${name}/module.json`, 'utf8'),
    ) as { name: string; publicEntry: string };
    const moduleDoc = await readFile(`src-next/${name}/MODULE.md`, 'utf8');
    expect(manifest.name).toBe(name);
    expect(manifest.publicEntry).toBe('./index.ts');
    expect(moduleDoc).toContain(`# ${name}`);
    expect(moduleDoc).toContain('## Does not own');
    expect(moduleDoc).toContain('## Invariants');
  });
});
```

- [ ] **Step 2: Run the test and confirm missing manifests**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/architecture/module-manifests.test.ts
```

Expected: FAIL with `ENOENT` for the first missing `module.json`.

- [ ] **Step 3: Create all module manifests**

Use this exact dependency map:

```json
{
  "kernel": [],
  "persistence": ["kernel"],
  "work": ["kernel"],
  "resources": ["kernel", "work"],
  "activities": ["kernel", "work", "resources"],
  "orchestration": ["kernel", "work", "activities"],
  "execution": ["kernel", "work", "activities"],
  "control-plane": ["kernel", "work", "resources", "orchestration", "execution"],
  "integrations": ["kernel", "work", "resources", "activities", "orchestration"],
  "surfaces": ["kernel", "work", "resources", "activities", "orchestration", "execution", "control-plane", "integrations"],
  "bootstrap": ["kernel", "persistence", "work", "resources", "activities", "orchestration", "execution", "control-plane", "integrations", "surfaces"]
}
```

Each `module.json` follows this shape:

```json
{
  "name": "work",
  "kind": "domain",
  "dependencies": ["kernel"],
  "publicEntry": "./index.ts",
  "namespaces": {
    "events": ["work."],
    "config": ["work"],
    "relations": ["work."]
  }
}
```

Use `kind: "foundation"` for `kernel`, `kind: "supporting"` for `persistence`,
`kind: "application"` for `control-plane`, `kind: "adapter"` for
`integrations`, `kind: "surface"` for `surfaces`, and `kind: "composition"` for
`bootstrap`. Use `kind: "domain"` for the other modules.

- [ ] **Step 4: Create concise module charters and public entries**

Every `MODULE.md` must contain exactly these top-level sections:

```markdown
# <module>

## Purpose
## Owns
## Does not own
## Invariants
## Public contracts
## Configuration
## Relations and events
## Failure and recovery
## Extension rules
## Scenarios
```

Fill each section from sections 6, 10, and 13 of the approved design. Keep each
file under 150 lines. Create an empty `index.ts` containing:

```ts
export {};
```

- [ ] **Step 5: Implement the manifest checker**

Create `scripts/check-module-manifests.mjs`:

```js
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'src-next';
const modules = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const manifests = new Map();
const failures = [];

for (const name of modules) {
  const path = join(root, name, 'module.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifests.set(name, manifest);
  if (manifest.name !== name) failures.push(`${path}: name must be ${name}`);
  if (manifest.publicEntry !== './index.ts') failures.push(`${path}: publicEntry must be ./index.ts`);
  if (!Array.isArray(manifest.dependencies)) failures.push(`${path}: dependencies must be an array`);
}

for (const [name, manifest] of manifests) {
  for (const dependency of manifest.dependencies ?? []) {
    if (!manifests.has(dependency)) failures.push(`${name}: unknown dependency ${dependency}`);
    if (dependency === name) failures.push(`${name}: cannot depend on itself`);
  }
}

function visit(name, path = []) {
  if (path.includes(name)) {
    failures.push(`module cycle: ${[...path, name].join(' -> ')}`);
    return;
  }
  for (const dependency of manifests.get(name)?.dependencies ?? []) {
    visit(dependency, [...path, name]);
  }
}
for (const name of modules) visit(name);

if (failures.length > 0) {
  process.stderr.write(`${[...new Set(failures)].join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Module manifests valid: ${modules.length} modules\n`);
}
```

- [ ] **Step 6: Add dependency-cruiser rules**

Create `dependency-cruiser.config.mjs` with these required rules:

```js
const modules = [
  'kernel',
  'persistence',
  'work',
  'resources',
  'activities',
  'orchestration',
  'execution',
  'control-plane',
  'integrations',
  'surfaces',
  'bootstrap',
];

const dependencyMap = {
  kernel: [],
  persistence: ['kernel'],
  work: ['kernel'],
  resources: ['kernel', 'work'],
  activities: ['kernel', 'work', 'resources'],
  orchestration: ['kernel', 'work', 'activities'],
  execution: ['kernel', 'work', 'activities'],
  'control-plane': ['kernel', 'work', 'resources', 'orchestration', 'execution'],
  integrations: ['kernel', 'work', 'resources', 'activities', 'orchestration'],
  surfaces: ['kernel', 'work', 'resources', 'activities', 'orchestration', 'execution', 'control-plane', 'integrations'],
  bootstrap: ['kernel', 'persistence', 'work', 'resources', 'activities', 'orchestration', 'execution', 'control-plane', 'integrations', 'surfaces'],
};

const internalBoundaryRules = modules.map((module) => ({
  name: `no-${module}-internals`,
  severity: 'error',
  from: { pathNot: `^src-next/${module}/` },
  to: { path: `^src-next/${module}/(?!index\\.ts$)` },
}));

const undeclaredDependencyRules = Object.entries(dependencyMap).map(([module, dependencies]) => {
  const permitted = [module, ...dependencies].join('|');
  return {
    name: `no-undeclared-${module}-dependency`,
    severity: 'error',
    from: { path: `^src-next/${module}/` },
    to: { path: `^src-next/(?!(?:${permitted})/)` },
  };
});

export default {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-legacy-imports',
      severity: 'error',
      from: { path: '^src-next/' },
      to: { path: '^src/' },
    },
    {
      name: 'kernel-has-no-domain-dependencies',
      severity: 'error',
      from: { path: '^src-next/kernel/' },
      to: { path: '^src-next/(?!kernel/)' },
    },
    {
      name: 'filesystem-io-stays-in-adapters',
      severity: 'error',
      from: {
        path: '^src-next/(?!persistence/|execution/infrastructure/(?:workspace/|transcripts\\.ts$)|bootstrap/)',
      },
      to: { path: '^node:fs' },
    },
    ...internalBoundaryRules,
    ...undeclaredDependencyRules,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|dist-next|node_modules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.next.json' },
  },
};
```

- [ ] **Step 7: Add maintainability limits and Knip config**

Add this TypeScript override to `eslint.config.js`:

```js
{
  files: ['src-next/**/*.ts', 'test-next/**/*.ts'],
  rules: {
    complexity: ['error', 12],
    'max-depth': ['error', 4],
    'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
    'max-params': ['error', 5],
  },
}
```

Create `knip.next.json`:

```json
{
  "entry": ["src-next/main.ts", "test-next/**/*.test.ts"],
  "project": ["src-next/**/*.ts", "test-next/**/*.ts"],
  "ignore": ["src-next/surfaces/ui/assets.ts"]
}
```

Add this `package.json` script:

```json
"lint:architecture": "node scripts/check-module-manifests.mjs && depcruise --config dependency-cruiser.config.mjs src-next"
```

- [ ] **Step 8: Verify guardrails**

Run:

```powershell
npm run lint:architecture
npm run test:next -- test-next/architecture/module-manifests.test.ts
npm run verify:next
```

Expected: all commands PASS and report eleven valid modules.

- [ ] **Step 9: Commit the boundaries**

```powershell
git add src-next test-next/architecture dependency-cruiser.config.mjs knip.next.json scripts/check-module-manifests.mjs eslint.config.js package.json
git commit -m "build: enforce target module boundaries"
```

## Task 4: Implement kernel identifiers and event contracts

**Files:**

- Create: `src-next/kernel/contracts/{clock,commands,event-journal,events,id-generator,identifiers}.ts`
- Create: `src-next/kernel/domain/event-envelope.ts`
- Create: `src-next/kernel/infrastructure/{system-clock,ulid-id-generator}.ts`
- Create: `src-next/persistence/memory/in-memory-event-journal.ts`
- Modify: `src-next/kernel/index.ts`
- Modify: `src-next/persistence/index.ts`
- Create: `test-next/kernel/event-envelope.test.ts`
- Create: `test-next/persistence/in-memory-event-journal.test.ts`

- [ ] **Step 1: Write event-envelope and optimistic-append tests**

Create `test-next/kernel/event-envelope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createEventDraft, entityRef } from '../../src-next/kernel/index.js';

describe('event envelope', () => {
  it('keeps domain payload separate from universal metadata', () => {
    const draft = createEventDraft({
      eventId: 'evt-1',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr-1',
      causationId: 'cmd-1',
      actor: { kind: 'system', id: 'wake' },
      source: { kind: 'internal', id: 'wake' },
      stream: entityRef('work-item', 'work-1'),
      payload: { objective: 'Ship the change' },
    });

    expect(draft.schemaVersion).toBe(1);
    expect(draft.payload).toEqual({ objective: 'Ship the change' });
    expect(draft).not.toHaveProperty('github');
  });
});
```

Create `test-next/persistence/in-memory-event-journal.test.ts` with cases for:

```ts
it('assigns stream sequence and global position atomically');
it('rejects an append whose expected sequence is stale');
it('reads a logical stream in sequence order');
it('reads all events after an exclusive global position');
it('returns the prior append for a repeated event id instead of duplicating it');
```

- [ ] **Step 2: Run the tests and confirm missing kernel exports**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/kernel test-next/persistence/in-memory-event-journal.test.ts
```

Expected: FAIL because `src-next/kernel/index.ts` does not export the contracts.

- [ ] **Step 3: Define the universal identifiers and envelope**

Use these contracts:

```ts
// contracts/identifiers.ts
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type EventId = Brand<string, 'EventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type CausationId = Brand<string, 'CausationId'>;

export interface EntityRef<Kind extends string = string> {
  readonly kind: Kind;
  readonly id: string;
}

export function entityRef<Kind extends string>(kind: Kind, id: string): EntityRef<Kind> {
  if (id.trim().length === 0) throw new Error('Entity reference id must not be empty');
  return { kind, id };
}

export const eventId = (value: string): EventId => nonEmpty(value, 'event id') as EventId;
export const correlationId = (value: string): CorrelationId =>
  nonEmpty(value, 'correlation id') as CorrelationId;
export const causationId = (value: string): CausationId =>
  nonEmpty(value, 'causation id') as CausationId;

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}
```

```ts
// contracts/events.ts
import type { CausationId, CorrelationId, EntityRef, EventId } from './identifiers.js';

export interface EventActor {
  readonly kind: 'system' | 'operator' | 'agent' | 'integration';
  readonly id: string;
}

export interface EventSource {
  readonly kind: 'internal' | 'adapter';
  readonly id: string;
}

export interface EventDraft<Type extends string = string, Payload = unknown> {
  readonly eventId: EventId;
  readonly eventType: Type;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly actor: EventActor;
  readonly source: EventSource;
  readonly stream: EntityRef;
  readonly payload: Payload;
}

export interface EventEnvelope<Type extends string = string, Payload = unknown>
  extends EventDraft<Type, Payload> {
  readonly recordedAt: string;
  readonly sequence: number;
  readonly globalPosition: number;
}
```

```ts
// contracts/commands.ts
import type { CorrelationId } from './identifiers.js';
import type { EventActor } from './events.js';

export interface CommandContext {
  readonly commandId: string;
  readonly correlationId: CorrelationId;
  readonly actor: EventActor;
  readonly occurredAt: string;
}
```

`createEventDraft` validates non-empty identifiers, valid ISO timestamps,
non-empty event type, and returns `schemaVersion: 1`. It performs no I/O.

- [ ] **Step 4: Define the journal and clock ports**

```ts
// contracts/event-journal.ts
import type { EntityRef } from './identifiers.js';
import type { EventDraft, EventEnvelope } from './events.js';

export class WrongExpectedSequenceError extends Error {}

export interface EventJournal {
  append(
    stream: EntityRef,
    expectedSequence: number,
    events: readonly EventDraft[],
  ): Promise<readonly EventEnvelope[]>;
  readStream(stream: EntityRef): Promise<readonly EventEnvelope[]>;
  readAll(afterGlobalPosition: number, limit?: number): Promise<readonly EventEnvelope[]>;
}
```

```ts
// contracts/clock.ts
export interface Clock {
  now(): Date;
}
```

```ts
// contracts/id-generator.ts
export interface IdGenerator {
  next(prefix: string): string;
}
```

- [ ] **Step 5: Implement the in-memory Persistence adapter**

The implementation must:

- key streams by `${kind}:${id}`;
- start stream sequence and global position at `1`;
- compare `expectedSequence` with the current stream length;
- assign one `recordedAt` value from the injected Clock per append;
- maintain a global `eventId` index;
- return the previously stored event for an exactly repeated event ID;
- reject an event ID reused with different content.

Use constructor signature:

```ts
export class InMemoryEventJournal implements EventJournal {
  constructor(private readonly clock: Clock) {}
}
```

- [ ] **Step 6: Export Kernel contracts and the Persistence adapter**

`src-next/kernel/index.ts` exports only contracts, pure constructors, system
clock, and ID generation:

```ts
export * from './contracts/clock.js';
export * from './contracts/commands.js';
export * from './contracts/event-journal.js';
export * from './contracts/events.js';
export * from './contracts/id-generator.js';
export * from './contracts/identifiers.js';
export * from './domain/event-envelope.js';
export * from './infrastructure/system-clock.js';
export * from './infrastructure/ulid-id-generator.js';
```

`UlidIdGenerator.next(prefix)` validates `prefix` against
`/^[a-z][a-z0-9-]*$/`, calls the existing `ulid()` dependency, and returns
`${prefix}-${ulid().toLowerCase()}`.

`src-next/persistence/index.ts` exports
`./memory/in-memory-event-journal.js`. Tests and bootstrap import it through
the Persistence public entry, never Kernel internals.

Define typed relation primitives in `contracts/relations.ts`:

```ts
import type { EntityRef } from './identifiers.js';

export interface RelationDefinition<Name extends string = string> {
  readonly owner: string;
  readonly name: Name;
  readonly fromKind: string;
  readonly toKind: string;
}

export interface Relation<Name extends string = string> {
  readonly relationId: string;
  readonly definition: RelationDefinition<Name>;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly establishedByEventId: string;
}
```

`createRelation(definition, input)` in `domain/relation.ts` rejects mismatched
entity kinds. Do not export a constructor that accepts an unregistered relation
name without a `RelationDefinition`.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/kernel test-next/persistence/in-memory-event-journal.test.ts
npm run verify:next
npm test
```

Expected: kernel tests, target verification, and legacy suite PASS.

```powershell
git add src-next/kernel src-next/persistence test-next/kernel test-next/persistence
git commit -m "feat: add target event kernel"
```

## Task 5: Build the event-model E2E world

**Files:**

- Create: `test-next/e2e/support/{faults,scenario,trace,world}.ts`
- Create: `test-next/e2e/scenario-harness.test.ts`

- [ ] **Step 1: Write the harness contract test**

Create `test-next/e2e/scenario-harness.test.ts`:

```ts
import { describe, expect } from 'vitest';
import { defineScenario } from './support/scenario.js';
import { TestWorld } from './support/world.js';

describe('event-model scenario harness', () => {
  defineScenario(
    {
      id: 'E2E-HARNESS-001',
      title: 'causal traces are readable',
      given: ['a deterministic world'],
      when: ['one event is appended'],
      then: ['the trace names the event and causation'],
    },
    async () => {
      const world = new TestWorld();
      await world.appendFact('work.item-created', { objective: 'test' }, 'cmd-1');
      expect(await world.trace()).toBe(
        '1 work.item-created stream=test:scenario cause=cmd-1 payload={"objective":"test"}',
      );
    },
  );
});
```

- [ ] **Step 2: Run the test and confirm missing support code**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e/scenario-harness.test.ts
```

Expected: FAIL resolving `./support/scenario.js`.

- [ ] **Step 3: Implement the thin scenario wrapper**

`defineScenario` must use the scenario ID and event-model sentences as the test
name; it must not implement policy:

```ts
import { it } from 'vitest';

export interface ScenarioDescription {
  readonly id: `E2E-${string}`;
  readonly title: string;
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
}

export function defineScenario(
  description: ScenarioDescription,
  run: () => Promise<void>,
): void {
  const text = [
    `${description.id}: ${description.title}`,
    ...description.given.map((value) => `Given ${value}`),
    ...description.when.map((value) => `When ${value}`),
    ...description.then.map((value) => `Then ${value}`),
  ].join('\n');
  it(text, run);
}
```

- [ ] **Step 4: Implement deterministic time, IDs, trace, and faults**

`TestWorld` uses:

```ts
export class FakeClock implements Clock {
  private current = new Date('2026-07-30T12:00:00.000Z');
  now(): Date { return new Date(this.current); }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequentialIds implements IdGenerator {
  private nextValue = 1;
  next(prefix: string): string {
    return `${prefix}-${this.nextValue++}`;
  }
}
```

`FaultInjector.failOnce(name)` arms a named failure.
`FaultInjector.check(name)` throws `InjectedFaultError` once and disarms it.
No production module imports this class.

`formatTrace(events)` emits one line per event using global position, event
type, stream, causation ID, and JSON payload. Do not include volatile
`recordedAt` in traces.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e
npm run verify:next
```

Expected: harness scenario PASS with a stable trace.

```powershell
git add test-next/e2e
git commit -m "test: add target event-model scenario world"
```

## Task 6: Implement WorkItem ownership

**Files:**

- Create: `src-next/work/contracts/{commands,events,identifiers,views}.ts`
- Create: `src-next/work/domain/work-item.ts`
- Create: `src-next/work/application/{work-repository,work-service}.ts`
- Modify: `src-next/work/index.ts`
- Create: `test-next/work/{work-item,work-service}.test.ts`

- [ ] **Step 1: Write WorkItem aggregate tests**

Cover these exact cases:

```ts
it('creates Wake-owned work without a provider identity');
it('rejects an empty objective');
it('replays objective revisions in stream order');
it('links two WorkItems with a typed work relation');
it('does not expose workflow stage or Run state in WorkItemView');
```

The first expected view is:

```ts
{
  workItemId: 'work-1',
  objective: 'Implement the target spine',
  state: 'open',
  relatedWorkItems: [],
}
```

- [ ] **Step 2: Run the tests and confirm missing Work contracts**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/work
```

Expected: FAIL resolving `src-next/work/index.js`.

- [ ] **Step 3: Define Work commands, events, and view**

Use these public types:

```ts
export type WorkItemId = Brand<string, 'WorkItemId'>;
export const workItemId = (value: string): WorkItemId => {
  if (!/^work-[a-z0-9-]+$/.test(value)) throw new Error(`Invalid WorkItemId: ${value}`);
  return value as WorkItemId;
};

export type WorkState = 'open' | 'closed' | 'cancelled';

export interface CreateWorkItem {
  readonly workItemId: WorkItemId;
  readonly objective: string;
}

export interface ReviseWorkObjective {
  readonly workItemId: WorkItemId;
  readonly objective: string;
}

export interface LinkWorkItems {
  readonly from: WorkItemId;
  readonly to: WorkItemId;
  readonly relation: 'relates-to' | 'parent-of' | 'child-of';
}

export type WorkEvent =
  | EventEnvelope<'work.item-created', { objective: string }>
  | EventEnvelope<'work.objective-revised', { objective: string }>
  | EventEnvelope<'work.item-linked', { to: WorkItemId; relation: LinkWorkItems['relation'] }>
  | EventEnvelope<'work.item-closed', { reason: string }>
  | EventEnvelope<'work.item-cancelled', { reason: string }>;
```

`WorkItemView` contains only Work-owned fields. Do not add `stage`,
`lastRunId`, `repo`, `issueNumber`, or provider labels.

- [ ] **Step 4: Implement pure folding and repository append**

`foldWorkItem(events)`:

- requires the first event to be `work.item-created`;
- rejects a second creation event;
- applies revisions and lifecycle facts in sequence;
- deduplicates identical typed WorkItem links;
- returns `null` for an empty stream.

`WorkRepository.load(id)` reads `entityRef('work-item', id)`.
`WorkRepository.append(id, expectedSequence, drafts)` delegates to the journal.
It contains no filesystem logic.

- [ ] **Step 5: Implement WorkService commands**

Use this API:

```ts
export interface WorkService {
  create(command: CreateWorkItem, context: CommandContext): Promise<WorkItemView>;
  revise(command: ReviseWorkObjective, context: CommandContext): Promise<WorkItemView>;
  link(command: LinkWorkItems, context: CommandContext): Promise<WorkItemView>;
  close(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  cancel(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  get(workItemId: WorkItemId): Promise<WorkItemView | null>;
}
```

Every command:

- validates current Work state;
- creates events using the command ID as causation;
- appends with the loaded sequence;
- reloads and returns the public view;
- relies on event-ID idempotency for a repeated command.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/work
npm run verify:next
npm test -- test/domain/work-item-status.test.ts test/lib/work-id.test.ts
```

Expected: target Work tests and selected legacy evidence tests PASS.

```powershell
git add src-next/work test-next/work docs/architecture/functional-decision-catalogue.md
git commit -m "feat: add target WorkItem domain"
```

## Task 7: Implement specialist Resources and typed correlations

**Files:**

- Create: `src-next/resources/contracts/{commands,events,identifiers,views}.ts`
- Create: `src-next/resources/domain/{correlation,resource}.ts`
- Create: `src-next/resources/application/{resource-repository,resource-service}.ts`
- Modify: `src-next/resources/index.ts`
- Create: `test-next/resources/{correlation,resource-service}.test.ts`
- Create: `test-next/e2e/scenarios/work-resource-correlation.test.ts`

- [ ] **Step 1: Write correlation tests**

Cover:

```ts
it('discovers any provider resource behind an opaque adapter key');
it('correlates a Resource to a WorkItem using a registered relation definition');
it('repeating the same correlation is idempotent');
it('rejects a second primary WorkItem correlation and records conflict evidence');
it('permits explicit secondary correlation without changing the primary');
it('retracts a correlation without deleting either specialist entity');
```

The target resource view must use:

```ts
{
  resourceId: 'resource-1',
  kind: 'pull-request',
  externalKey: { adapter: 'fake', key: 'repo/pulls/7' },
  capabilities: ['reviewable', 'mergeable', 'revisioned'],
  revision: 'sha-a',
}
```

- [ ] **Step 2: Run tests and confirm missing Resource contracts**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/resources
```

Expected: FAIL resolving Resource exports.

- [ ] **Step 3: Define canonical Resource contracts**

Use:

```ts
export type ResourceId = Brand<string, 'ResourceId'>;
export type ResourceCapability =
  | 'commentable'
  | 'reviewable'
  | 'approvable'
  | 'mergeable'
  | 'revisioned'
  | 'editable';

export interface ExternalResourceKey {
  readonly adapter: string;
  readonly key: string;
}

export interface ResourceView {
  readonly resourceId: ResourceId;
  readonly kind: string;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string;
}

export interface ResourceCorrelationView {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly role: 'primary' | 'secondary';
  readonly establishedByEventId: string;
}
```

Provider payloads and GitHub field names are absent.

- [ ] **Step 4: Define owned events and relation**

Events:

```text
resources.resource-discovered
resources.resource-revision-observed
resources.work-correlation-established
resources.work-correlation-retracted
resources.work-correlation-conflicted
```

Export one relation definition:

```ts
export const resourceRepresentsWork = {
  owner: 'resources',
  name: 'resources.represents-work',
  fromKind: 'resource',
  toKind: 'work-item',
} as const satisfies RelationDefinition<'resources.represents-work'>;
```

Only `ResourceService` may establish or retract this relation.

- [ ] **Step 5: Implement replay-based lookup and conflict policy**

The initial `ResourceRepository` reads the journal and folds:

- resource stream by `resourceId`;
- external-key lookup from all `resources.resource-discovered` events;
- active correlations from establish/retract events.

No mutable index is required yet. `correlate(..., role: 'primary')` emits a
conflict event and returns a rejected result if another WorkItem already holds
the primary link. It does not silently demote the requested link.

- [ ] **Step 6: Add the target event-model scenario**

Use scenario ID `E2E-WORK-001`:

```text
Given integration.fake.resource-discovered repo/issues/7
When  work intake is accepted
Then  work.item-created
  And resources.resource-discovered
  And resources.work-correlation-established role primary
  And the WorkItem contains no provider identity
```

Drive public services with the test world and assert canonical events/views.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/resources test-next/e2e/scenarios/work-resource-correlation.test.ts
npm run verify:next
npm test -- test/core/event-resolver.test.ts test/adapters/resource-index.test.ts
```

Expected: target and selected legacy evidence tests PASS.

```powershell
git add src-next/resources test-next/resources test-next/e2e/scenarios docs/architecture/functional-decision-catalogue.md
git commit -m "feat: add target Resource correlation domain"
```

## Task 8: Define Activities and the registry

**Files:**

- Create: `src-next/activities/contracts/{activity,events,registry}.ts`
- Create: `src-next/activities/agent/{agent-activity,agent-result}.ts`
- Modify: `src-next/activities/index.ts`
- Create: `test-next/activities/{activity-registry,agent-result}.test.ts`

- [ ] **Step 1: Write Activity contract tests**

Cover:

```ts
it('registers a named Activity with typed input and outcome schemas');
it('rejects duplicate Activity names');
it('rejects invalid activity.with input before a Run exists');
it('declares resource capability and cardinality requirements');
it('maps a structured agent result to done, rejected, blocked, or failed');
it('never treats missing structured agent output as done');
```

- [ ] **Step 2: Run and confirm missing Activity registry**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities
```

Expected: FAIL resolving Activity exports.

- [ ] **Step 3: Implement the public Activity contract**

```ts
import type { z } from 'zod';

export interface ResourceRequirement {
  readonly capability: ResourceCapability;
  readonly cardinality: 'zero-or-one' | 'exactly-one' | 'one-or-more';
  readonly role?: 'primary' | 'secondary';
}

export interface ActivityInvocation<Input = unknown> {
  readonly activationId: string;
  readonly activity: string;
  readonly workItemId: WorkItemId;
  readonly workflowInstanceId: string;
  readonly orchestrationGroupId: string;
  readonly causationId: string;
  readonly input: Input;
  readonly resources: readonly ResourceView[];
}

export interface ActivityOutcome<Kind extends string = string, Data = unknown> {
  readonly kind: Kind;
  readonly data?: Data;
}

export interface ActivityExecutionContext {
  readonly signal: AbortSignal;
  reportExternalExecution(reference: {
    readonly kind: 'process' | 'remote-session';
    readonly id: string;
    readonly startedAt: string;
  }): Promise<void>;
}

export interface ActivityHandler<Input = unknown> {
  execute(
    invocation: ActivityInvocation<Input>,
    context: ActivityExecutionContext,
  ): Promise<ActivityOutcome>;
}

export interface ActivityDefinition<Input = unknown> {
  readonly name: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly outcomeSchema: z.ZodType<ActivityOutcome>;
  readonly resources: readonly ResourceRequirement[];
  readonly executionKind: 'agent' | 'script' | 'deterministic';
  readonly handler: ActivityHandler<Input>;
}
```

- [ ] **Step 4: Implement ActivityRegistry**

API:

```ts
register(definition: ActivityDefinition): void;
get(name: string): ActivityDefinition;
validateInput(name: string, input: unknown): unknown;
validateOutcome(name: string, output: unknown): ActivityOutcome;
list(): readonly ActivityDefinition[];
```

Names must match `/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/`. Registry lookup,
input validation, and output validation errors include the Activity name and
Zod issue path.

- [ ] **Step 5: Implement the initial agent result translator**

Accept the structured Wake result envelope and map:

```text
DONE -> { kind: 'done', data: envelope }
REJECTED -> { kind: 'rejected', data: envelope }
BLOCKED -> { kind: 'blocked', data: envelope }
FAILED -> { kind: 'failed', data: envelope }
missing/malformed -> { kind: 'failed', data: { reason: 'invalid-agent-result' } }
```

The translator consumes runner output; it does not choose workflow
transitions.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities
npm run verify:next
npm test -- test/domain/schema.test.ts
```

Expected: Activity tests and legacy result-envelope evidence PASS.

```powershell
git add src-next/activities test-next/activities docs/architecture/functional-decision-catalogue.md
git commit -m "feat: define target Activity contracts"
```

## Task 9: Compile domain-shaped workflow configuration

**Files:**

- Create: `src-next/orchestration/contracts/{config,identifiers}.ts`
- Create: `src-next/orchestration/domain/compiler.ts`
- Modify: `src-next/orchestration/index.ts`
- Create: `test-next/orchestration/workflow-compiler.test.ts`

- [ ] **Step 1: Write compiler tests**

Cover:

```ts
it('compiles activity, with, execution, and on under their owning shapes');
it('uses the first configured stage when entry is omitted');
it('rejects an unknown Activity');
it('rejects invalid Activity-owned with input');
it('rejects an unknown transition target');
it('rejects an unreachable stage');
it('rejects a static cycle without an explicit repeat limit');
it('accepts a cycle when every cycle-closing route declares repeat.max');
it('does not require a repository, issue, or provider in workflow config');
```

- [ ] **Step 2: Run and confirm compiler absence**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration/workflow-compiler.test.ts
```

Expected: FAIL resolving the compiler.

- [ ] **Step 3: Define the raw and compiled configuration**

```ts
export interface FollowOnActivityConfig {
  readonly use: string;
  readonly with?: unknown;
}

export interface OutcomeRouteConfig {
  readonly activities?: readonly FollowOnActivityConfig[];
  readonly then: string | 'done' | 'await-human';
  readonly repeat?: { readonly max: number };
  readonly retry?: { readonly max: number };
}

export interface StageConfig {
  readonly activity: string;
  readonly with?: unknown;
  readonly execution?: {
    readonly workspace?: 'none' | 'read-only' | 'branch';
    readonly tier?: string;
  };
  readonly on: Readonly<Record<string, OutcomeRouteConfig>>;
}

export interface WorkflowDefinitionConfig {
  readonly entry?: string;
  readonly stages: Readonly<Record<string, StageConfig>>;
}
```

Zod schemas require at least one stage, at least one outcome route per stage,
positive integer `repeat.max` and `retry.max`, non-empty identifiers, and
strict objects. `retry` means that Orchestration may request a new Run for the
same stage Activity before following `then`; it is not an Execution transport
retry. `with` remains `unknown` until ActivityRegistry validation. Execution
performs its own resolved-config validation in Task 11.

- [ ] **Step 4: Implement graph validation**

`compileWorkflow(name, config, activityRegistry)` returns immutable compiled
stages and:

- validates all stage and follow-on Activity inputs;
- validates transition targets;
- calculates reachability from the entry;
- rejects unreachable stages;
- finds strongly connected components;
- requires every route that closes a cycle to have `repeat.max`;
- gives each route a stable ID
  `${workflowName}:${stageName}:${outcomeKind}`.

Do not add workflow-definition persistence or versions.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration/workflow-compiler.test.ts
npm run verify:next
npm test -- test/domain/workflows.test.ts test/domain/schema.test.ts
```

Expected: target compiler and legacy workflow/config evidence PASS.

```powershell
git add src-next/orchestration test-next/orchestration docs/architecture/functional-decision-catalogue.md
git commit -m "feat: compile target workflow definitions"
```

## Task 10: Implement WorkflowInstance interpretation

**Files:**

- Create: `src-next/orchestration/contracts/{commands,events,views}.ts`
- Create: `src-next/orchestration/domain/{interpreter,workflow-instance}.ts`
- Create: `src-next/orchestration/application/{orchestration-repository,orchestration-service}.ts`
- Modify: `src-next/orchestration/index.ts`
- Create: `test-next/orchestration/{interpreter,orchestration-service}.test.ts`

- [ ] **Step 1: Write pure interpreter tests**

Cover:

```ts
it('starts one instance at the compiled entry stage');
it('requests one durable ActivityActivation for the current stage');
it('accepts an outcome only for the pending activation');
it('runs follow-on activities in configured order before transitioning');
it('waits for a human signal without creating a Run');
it('completes after the terminal route');
it('consumes a duplicate outcome exactly once');
it('counts bounded repeats by route and orchestration group');
it('blocks before repeat.max is exceeded');
```

- [ ] **Step 2: Run and confirm interpreter absence**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration
```

Expected: FAIL resolving interpreter/service exports.

- [ ] **Step 3: Define WorkflowInstance view and events**

```ts
export interface ActivityActivationView {
  readonly activationId: string;
  readonly ordinal: number;
  readonly activity: string;
  readonly input: unknown;
  readonly execution: StageConfig['execution'];
  readonly status: 'pending' | 'running' | 'completed';
}

export interface WorkflowInstanceView {
  readonly workflowInstanceId: string;
  readonly workItemId: WorkItemId;
  readonly workflowName: string;
  readonly orchestrationGroupId: string;
  readonly status: 'active' | 'waiting' | 'completed' | 'blocked' | 'superseded';
  readonly currentStage: string;
  readonly pendingActivation?: ActivityActivationView;
  readonly repeatCounts: Readonly<Record<string, number>>;
}
```

Owned event types:

```text
orchestration.instance-started
orchestration.stage-entered
orchestration.activity-requested
orchestration.activity-started
orchestration.activity-outcome-accepted
orchestration.signal-wait-started
orchestration.signal-accepted
orchestration.repeat-counted
orchestration.instance-completed
orchestration.instance-blocked
orchestration.instance-superseded
```

WorkItem contains only the WorkflowInstance reference/history relation, never
these fields.

- [ ] **Step 4: Implement the pure decision API**

```ts
export type OrchestrationDecision =
  | { readonly kind: 'append'; readonly events: readonly OrchestrationEventDraft[] }
  | { readonly kind: 'ignored'; readonly reason: string };

export function startInstance(input: StartInstanceInput): OrchestrationDecision;
export function acceptActivityOutcome(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): OrchestrationDecision;
export function acceptSignal(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptSignal,
): OrchestrationDecision;
```

Activations use stable IDs:
`${workflowInstanceId}:activity:${ordinal}`. Follow-on activities increment the
ordinal and run sequentially. `waiting` keeps the activation open for a typed
signal, `blocked` blocks the instance, and `failed` follows its Orchestration
retry/route policy. Only `done` advances to the next follow-on Activity or
transition.

- [ ] **Step 5: Implement repository and service**

`OrchestrationRepository` loads/folds one instance stream. The service:

- verifies the WorkItem exists and is open before start;
- appends start/transition events with expected sequence;
- exposes `listPendingActivations(workItemId?)`;
- accepts an Activity outcome idempotently;
- exposes waiting instances by signal kind.

It performs no Activity execution.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration
npm run verify:next
npm test -- test/domain/workflows.test.ts test/core/policy-engine.test.ts
```

Expected: interpreter tests and selected legacy decision evidence PASS.

```powershell
git add src-next/orchestration test-next/orchestration docs/architecture/functional-decision-catalogue.md
git commit -m "feat: add target workflow instances"
```

## Task 11: Execute Activities as explicit Runs

**Files:**

- Create: `src-next/execution/contracts/{config,events,views,workspace}.ts`
- Create: `src-next/execution/domain/{run,run-result}.ts`
- Create: `src-next/execution/application/{execution-service,run-repository}.ts`
- Create: `src-next/execution/infrastructure/runners/fake.ts`
- Modify: `src-next/execution/index.ts`
- Create: `test-next/execution/{execution-service,run}.test.ts`

- [ ] **Step 1: Write Run boundary tests**

Cover:

```ts
it('creates one Run attempt for one ActivityActivation');
it('validates Activity input before recording run.started');
it('records the validated Activity outcome separately from transport status');
it('records handler failure as run.failed without choosing a workflow route');
it('does not allocate a workspace when execution.workspace is none');
it('rejects an unregistered execution tier');
```

- [ ] **Step 2: Run and confirm Execution absence**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution
```

Expected: FAIL resolving Execution exports.

- [ ] **Step 3: Define Run contracts**

```ts
export type RunTransportStatus =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'ambiguous';

export interface RunView {
  readonly runId: string;
  readonly activationId: string;
  readonly activity: string;
  readonly attempt: number;
  readonly status: RunTransportStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: ActivityOutcome;
  readonly failure?: { readonly kind: string; readonly message: string };
  readonly workspace?: { readonly mode: 'read-only' | 'branch'; readonly path: string };
}

export interface ExecutionConfig {
  readonly tiers: Readonly<Record<string, readonly string[]>>;
  readonly defaultTier: string;
}
```

Owned events:

```text
execution.run-started
execution.run-succeeded
execution.run-failed
execution.run-cancellation-requested
execution.run-cancelled
execution.run-ambiguous
execution.run-reconciled
```

- [ ] **Step 4: Define the workspace port**

```ts
export interface WorkspaceRequest {
  readonly mode: 'read-only' | 'branch';
  readonly workItemId: WorkItemId;
  readonly repositoryResource: ResourceView;
}

export interface WorkspaceLease {
  readonly workspaceId: string;
  readonly path: string;
  readonly mode: WorkspaceRequest['mode'];
  release(): Promise<void>;
}

export interface WorkspaceProvider {
  acquire(request: WorkspaceRequest): Promise<WorkspaceLease>;
}
```

No `repo` or `issueNumber` is present. Repository location and branch naming
are resolved from Resource capabilities inside the concrete provider.

- [ ] **Step 5: Implement ExecutionService**

API:

```ts
attempt(
  activation: ActivityActivationView,
  context: {
    readonly workItemId: WorkItemId;
    readonly workflowInstanceId: string;
    readonly orchestrationGroupId: string;
    readonly resources: readonly ResourceView[];
  },
): Promise<RunView>;
```

The service:

1. gets and validates the Activity definition/input;
2. resolves declared resource cardinality;
3. validates Execution config;
4. creates a Run ID and appends `execution.run-started`;
5. calls the Activity handler with an Execution-owned
   `ActivityExecutionContext`;
6. validates its outcome;
7. appends succeeded or failed;
8. releases a workspace in `finally`;
9. returns the Run view.

It does not call Orchestration.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution
npm run verify:next
npm test -- test/core/tick-runner.run-recording.test.ts test/core/run-lease.test.ts
```

Expected: target Execution tests and selected legacy Run evidence PASS.

```powershell
git add src-next/execution test-next/execution docs/architecture/functional-decision-catalogue.md
git commit -m "feat: execute target Activities as Runs"
```

## Task 12: Complete the first end-to-end golden path

**Files:**

- Create: `src-next/control-plane/contracts/views.ts`
- Create: `src-next/control-plane/application/{advance-once,control-plane-service}.ts`
- Modify: `src-next/control-plane/index.ts`
- Extend: `test-next/e2e/support/world.ts`
- Create: `test-next/e2e/scenarios/golden-path.test.ts`
- Create: `test-next/control-plane/advance-once.test.ts`

- [ ] **Step 1: Write the golden-path scenario**

Use `E2E-GOLDEN-001`:

```text
Given work.item-created for work-1
  And workflow.default is configured with implement -> done
  And implement is a fake Activity returning done
When  the WorkflowInstance starts
  And advanceOnce is called
Then  orchestration.activity-requested
  And execution.run-started
  And execution.run-succeeded outcome done
  And orchestration.activity-outcome-accepted
  And orchestration.instance-completed
  And no provider adapter was required
```

Assert the exact causal order, public Work view, WorkflowInstance view, and Run
view.

- [ ] **Step 2: Run and confirm missing control plane**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e/scenarios/golden-path.test.ts
```

Expected: FAIL resolving `control-plane`.

- [ ] **Step 3: Implement bounded `advanceOnce`**

```ts
export type AdvanceResult =
  | { readonly kind: 'no-work' }
  | { readonly kind: 'progressed'; readonly activationId: string; readonly runId: string }
  | { readonly kind: 'waiting'; readonly workflowInstanceId: string }
  | { readonly kind: 'blocked'; readonly workflowInstanceId: string; readonly reason: string }
  | { readonly kind: 'exhausted'; readonly progressCount: number };

export interface AdvanceOptions {
  readonly workItemId?: WorkItemId;
  readonly maxProgress: number;
}
```

One `advanceOnce` call:

1. first finds a completed Run whose activation outcome is not yet accepted;
2. otherwise finds one pending ActivityActivation;
3. marks the activation started;
4. calls Execution once;
5. submits the Run outcome to Orchestration;
6. returns without recursively dispatching another activation.

`maxProgress` is consumed by the resident/tick host in Task 22; it is not reset
by successful child work.

- [ ] **Step 4: Extend TestWorld with real target services**

`TestWorld` constructs one in-memory journal, fake clock, sequential IDs,
registries, repositories, and public application services. Provide only
domain-level helpers:

```ts
createWork(input): Promise<WorkItemView>;
discoverResource(input): Promise<ResourceView>;
configureWorkflow(name, config): CompiledWorkflow;
registerActivity(definition): void;
startWorkflow(input): Promise<WorkflowInstanceView>;
advance(workItemId?: WorkItemId): Promise<AdvanceResult>;
events(type?: string): Promise<readonly EventEnvelope[]>;
viewWork(id): Promise<WorkItemView | null>;
viewWorkflow(id): Promise<WorkflowInstanceView | null>;
viewRuns(activationId?: string): Promise<readonly RunView[]>;
```

Do not expose repositories or aggregate mutation to scenarios.

- [ ] **Step 5: Add crash-idempotency unit cases**

`advance-once.test.ts` covers:

```ts
it('does no work when no activation is pending');
it('accepts a completed Run before starting another');
it('does not create a second Run for a completed activation');
it('performs at most one execution attempt per call');
```

- [ ] **Step 6: Pass Packet B gate**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e/scenarios/golden-path.test.ts test-next/control-plane
npm run check:catalogue
npm run lint:architecture
npm run verify:next
npm run verify
```

Expected: one complete target workflow through real target modules; every
command PASSes.

- [ ] **Step 7: Commit the golden path**

```powershell
git add src-next/control-plane test-next/control-plane test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: complete target orchestration golden path"
```

## Task 13: Persist events, projections, and checkpoints beneath `.wake`

**Files:**

- Create: `src-next/kernel/contracts/{checkpoint-store,projection-store}.ts`
- Modify: `src-next/kernel/index.ts`
- Create: `src-next/persistence/application/projection-runner.ts`
- Create: `src-next/persistence/filesystem/{file-checkpoint-store,file-event-journal,file-lock,file-projection-store}.ts`
- Modify: `src-next/persistence/index.ts`
- Create: `test-next/persistence/{file-checkpoint-store,file-event-journal,file-lock,file-projection-store,projection-runner}.test.ts`
- Create: `test-next/e2e/scenarios/{journal-restart,projection-recovery}.test.ts`

- [ ] **Step 1: Write storage-port tests**

Define tests for:

```ts
it('stores a projection with its last applied global position');
it('atomically replaces one projection without touching another namespace');
it('loads and advances a named consumer checkpoint');
it('rejects checkpoint regression');
it('deletes all derived projections without deleting events');
```

- [ ] **Step 2: Define Kernel storage ports**

Create:

```ts
// checkpoint-store.ts
export interface CheckpointStore {
  load(consumer: string): Promise<number>;
  save(consumer: string, globalPosition: number): Promise<void>;
  reset(consumer: string): Promise<void>;
}

// projection-store.ts
export interface StoredProjection<Value = unknown> {
  readonly namespace: string;
  readonly key: string;
  readonly lastGlobalPosition: number;
  readonly value: Value;
}

export interface ProjectionStore {
  read<Value>(namespace: string, key: string): Promise<StoredProjection<Value> | null>;
  write<Value>(projection: StoredProjection<Value>): Promise<void>;
  list<Value>(namespace: string): Promise<readonly StoredProjection<Value>[]>;
  clear(namespace?: string): Promise<void>;
}

export interface ProjectionDefinition<Value = unknown> {
  readonly name: string;
  select(event: EventEnvelope): { readonly key: string } | null;
  initial(key: string): Value;
  project(previous: Value, event: EventEnvelope): Value;
}
```

Export ports from `kernel/index.ts`. Kernel contains no filesystem imports.

- [ ] **Step 3: Run and confirm filesystem adapters are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/persistence
```

Expected: FAIL resolving `src-next/persistence/index.js`.

- [ ] **Step 4: Port the proven lock primitive into Persistence**

Copy, do not import, the low-level lock:

```powershell
Copy-Item -LiteralPath src/lib/lock.ts -Destination src-next/persistence/filesystem/file-lock.ts
Copy-Item -LiteralPath test/lib/lock.test.ts -Destination test-next/persistence/file-lock.test.ts
```

Remove legacy domain imports and retarget the test. Persistence owns locking
for journal/projection/checkpoint files; Work and Orchestration never import
this implementation.

- [ ] **Step 5: Implement FileEventJournal under the hidden data root**

Constructor:

```ts
export class FileEventJournal implements EventJournal {
  constructor(
    private readonly wakeDataRoot: string,
    private readonly clock: Clock,
  ) {}
}
```

Paths:

```text
<wakeRoot>/.wake/events/YYYY-MM-DD.jsonl
<wakeRoot>/.wake/locks/event-journal.lock
```

`bootstrap/paths.ts` supplies `<wakeRoot>/.wake` as `wakeDataRoot`. Under the
append lock, scan ordered event files, validate complete lines, rebuild stream
sequence/global-position/event-ID indexes, enforce expected sequence and
idempotency, then append one newline-terminated batch. A corrupted complete
line reports file and line. A partial trailing line is reported as incomplete
state and is never returned as a valid event.

- [ ] **Step 6: Implement atomic projection and checkpoint adapters**

Paths:

```text
<wakeRoot>/.wake/projections/<namespace>/<encoded-key>.json
<wakeRoot>/.wake/checkpoints/<encoded-consumer>.json
```

Encode names with a reversible percent encoding and reject path separators
after decoding. Write to a sibling temporary file, `fsync` the file, rename it
over the destination, and clean the temporary file in `finally`.

Projection JSON:

```json
{
  "namespace": "work",
  "key": "work-1",
  "lastGlobalPosition": 17,
  "value": {}
}
```

Checkpoint JSON:

```json
{
  "consumer": "projection.work",
  "globalPosition": 17
}
```

- [ ] **Step 7: Implement the generic ProjectionRunner**

```ts
export class ProjectionRunner {
  constructor(
    private readonly journal: EventJournal,
    private readonly projections: ProjectionStore,
    private readonly checkpoints: CheckpointStore,
  ) {}

  async runOnce(definition: ProjectionDefinition, limit = 100): Promise<number>;
  async rebuild(definition: ProjectionDefinition): Promise<number>;
}
```

For each event after `projection:<definition.name>`:

1. ignore it when `select` returns null;
2. load the keyed projection or `initial(key)`;
3. skip the fold when its `lastGlobalPosition` already covers the event;
4. call the pure projector;
5. atomically write view plus event global position;
6. advance the consumer checkpoint only after the write;
7. return the number of consumed events.

`rebuild` clears only that definition's namespace and checkpoint, then replays
the journal. It never changes events.

- [ ] **Step 8: Register domain projection definitions**

Export pure `ProjectionDefinition`s from Work, Resources, Orchestration, and
Execution using their existing fold functions. Their namespaces are:

```text
work
resources
resource-correlations
orchestration
execution
```

Add target tests proving the same input event and prior view always return the
same output and do not append an event.

- [ ] **Step 9: Add persistence scenarios**

`E2E-JOURNAL-001`:

```text
Given process A writes Work and Workflow events under <wakeRoot>/.wake/events
When  process B opens the same Wake root
Then  it rebuilds the same public views
  And the next append continues sequence and global position
```

`E2E-PROJECTION-001`:

```text
Given an event is committed
  And a crash occurs before its projection checkpoint advances
When  the projection runner restarts
Then  the event is applied exactly once by global position
  And projection and checkpoint files are stored beneath <wakeRoot>/.wake
  And deleting projections followed by rebuild restores the same views
```

- [ ] **Step 10: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/persistence test-next/e2e/scenarios/journal-restart.test.ts test-next/e2e/scenarios/projection-recovery.test.ts
npm run lint:architecture
npm run verify:next
npm test -- test/adapters/state-store.test.ts test/core/projection-updater.test.ts test/lib/lock.test.ts
```

Expected: filesystem journal, persisted projections, recovery/rebuild, and
selected legacy persistence evidence PASS.

```powershell
git add src-next/kernel src-next/persistence src-next/work src-next/resources src-next/orchestration src-next/execution test-next/persistence test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: persist target state beneath Wake home"
```

## Task 14: Add one-way integration ingestion with a fake source

**Files:**

- Create: `src-next/integrations/fake/{external-source,external-sink}.ts`
- Create: `src-next/integrations/github/contracts/events.ts`
- Create: `src-next/integrations/github/application/inbound-translator.ts`
- Create: `src-next/integrations/github/application/poll-service.ts`
- Create: `src-next/integrations/delivery/contracts/events.ts`
- Modify: `src-next/integrations/index.ts`
- Create: `test-next/integrations/{inbound-translator,poll-service}.test.ts`
- Create: `test-next/e2e/scenarios/external-intake.test.ts`

- [ ] **Step 1: Write the directional-ingress tests**

Cover:

```ts
it('appends adapter evidence before translating it');
it('keeps adapter payload types inside integrations');
it('translates an external work observation into Work and Resource commands');
it('reprocessing the same adapter event does not mint another WorkItem');
it('does not let an integration append work.item-created directly');
```

- [ ] **Step 2: Run and confirm integration services are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations
```

Expected: FAIL resolving integration exports.

- [ ] **Step 3: Define adapter-owned evidence**

Use this provider-owned event shape:

```ts
export interface ExternalWorkObservedPayload {
  readonly externalKey: string;
  readonly kind: 'issue' | 'pull-request';
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly revision: string;
  readonly actor: { readonly id: string; readonly kind: 'human' | 'bot' };
  readonly raw: Readonly<Record<string, unknown>>;
}

export type GitHubAdapterEvent =
  | EventEnvelope<'integration.github.work-observed', ExternalWorkObservedPayload>
  | EventEnvelope<'integration.github.comment-observed', GitHubCommentObservedPayload>
  | EventEnvelope<'integration.github.delivery-observed', GitHubDeliveryObservedPayload>;
```

These events use `source: { kind: 'adapter', id: 'github' }`. No other module
imports these payload types.

- [ ] **Step 4: Implement PollService**

Port:

```ts
export interface ExternalEventSource {
  poll(signal: AbortSignal): Promise<readonly EventDraft[]>;
}
```

`PollService.pollOnce` asks one source for drafts and appends them to its
adapter stream. Stable provider delivery IDs become stable Wake event IDs.
Polling does not call Work, Resources, or Orchestration.

- [ ] **Step 5: Implement InboundTranslator**

`translate(event)` is pure and returns provider-neutral command candidates.
`runOnce(limit)` reads adapter events after checkpoint
`reactor:integration.github.inbound`; `apply(event)` uses public Work/Resource
services:

- find Resource by `{adapter: 'github', key: externalKey}`;
- on first observation, mint target Resource and Work IDs, discover the
  Resource, create Work, then correlate them;
- on later observation, update only Resource revision/state facts;
- never close Work solely because one external representation closed;
- use the adapter event ID as command causation and deterministic event-ID
  suffix;
- advance the reactor checkpoint only after every command candidate is
  idempotently accepted.

Stable command/event IDs make replay safe. The checkpoint is stored beneath
`.wake/checkpoints` by the Persistence adapter and is never business state.

- [ ] **Step 6: Add scenario `E2E-WORK-002`**

```text
Given integration.github.work-observed for issue owner/repo#7
When  inbound evidence is translated twice
Then  exactly one WorkItem exists
  And exactly one Resource exists
  And exactly one primary correlation exists
  And the adapter payload remains outside Work and Resource views
```

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations test-next/e2e/scenarios/external-intake.test.ts
npm run verify:next
npm test -- test/core/tick-runner.intake.test.ts test/core/event-resolver.test.ts
```

Expected: directional ingress and legacy intake evidence PASS.

```powershell
git add src-next/integrations test-next/integrations test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: add directional target ingress"
```

## Task 15: Port GitHub issue/PR observation and propose human signals

**Files:**

- Create: `src-next/integrations/github/contracts/{config,payloads}.ts`
- Create: `src-next/integrations/github/infrastructure/{client,etag-cache,issue-source,pr-source}.ts`
- Extend: `src-next/integrations/github/application/inbound-translator.ts`
- Create: `src-next/activities/review/{contracts,signals}.ts`
- Modify: `src-next/activities/index.ts`
- Create: `test-next/integrations/github-{client,issue-source,pr-source,signals}.test.ts`
- Create: `test-next/activities/review-signals.test.ts`
- Create: `test-next/e2e/scenarios/{external-closure,human-signal}.test.ts`

- [ ] **Step 1: Port accepted low-level GitHub client tests**

Copy these tests and change imports to target files:

```powershell
Copy-Item test/adapters/github-client.test.ts test-next/integrations/github-client.test.ts
Copy-Item test/adapters/github-client-request-log.test.ts test-next/integrations/github-client-request-log.test.ts
Copy-Item test/adapters/github-etag-cache.test.ts test-next/integrations/github-etag-cache.test.ts
```

Delete assertions that encode core EventEnvelope or WorkItem shapes. Retain
HTTP construction, pagination, ETag, authentication failure, rate metadata,
and request-scrubbing assertions.

- [ ] **Step 2: Run and confirm target GitHub infrastructure is missing**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations/github-client.test.ts
```

Expected: FAIL resolving the target GitHub client.

- [ ] **Step 3: Port the isolated client and ETag implementation**

Copy:

```powershell
Copy-Item src/adapters/github/github-client.ts src-next/integrations/github/infrastructure/client.ts
Copy-Item src/adapters/github/github-etag-cache.ts src-next/integrations/github/infrastructure/etag-cache.ts
```

Replace legacy domain imports with GitHub-owned payload/config contracts. The
client returns provider DTOs and rate metadata only. It does not construct
canonical events.

- [ ] **Step 4: Rewrite issue and PR sources around adapter evidence**

Implement sources with these responsibilities:

- qualify configured repositories and provider-side filters;
- poll issue/PR/comment/review/check changes;
- persist provider cursors/ETags as integration operational state;
- emit only `integration.github.*` drafts;
- set stable event IDs from provider delivery/object revision;
- mark actor kind and retain a diagnostic raw fragment;
- never resolve WorkItem identity or choose workflow policy.

Port accepted polling tests from:

```text
test/adapters/github-issues-work-source.test.ts
test/adapters/github-pull-request-activity-source.test.ts
```

Split target test files by observation type so each stays below 400 lines.

- [ ] **Step 5: Define proposed review signals**

Integration parsing emits:

```ts
export interface ProposedReviewSignal {
  readonly provider: 'github';
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly providerEventId: string;
  readonly kind: 'accepted' | 'changes-requested';
}
```

Recognize configured provider conventions only when the command occupies its
own trimmed line. Plain text containing `/approved`, `/accepted`, or `/changes`
is not a command. The Integration returns `SubmitReviewSignal`; it never emits
`review.signal-accepted`.

`ReviewSignalService` validates Resource correlation, expected wait, actor
authority, revision, and idempotency before emitting:

```text
activities.review-signal-accepted
activities.review-signal-rejected
```

- [ ] **Step 6: Add external closure and human-signal scenarios**

`E2E-WORK-003`:

```text
Given an open WorkItem represented by one GitHub issue
When  integration.github.work-observed reports the issue closed
Then  the Resource records closed
  And the WorkItem still exists
  And Work policy decides cancellation or continuation separately
```

`E2E-SIGNAL-001`:

```text
Given a WorkflowInstance waiting for accepted on pull-request revision A
When  an authorised GitHub actor comments /accepted for revision A
Then  activities.review-signal-accepted
  And orchestration.signal-accepted
```

Add variants for bot actor, unauthorised human, stale revision, duplicate
provider event, wrong Resource, conversational substring, and `/changes`.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations test-next/activities/review-signals.test.ts test-next/e2e/scenarios/external-closure.test.ts test-next/e2e/scenarios/human-signal.test.ts
npm run verify:next
npm test -- test/adapters/github-client.test.ts test/adapters/github-issues-work-source.test.ts test/core/policy-engine.test.ts
```

Expected: target provider boundary and accepted legacy provider evidence PASS.

```powershell
git add src-next/integrations src-next/activities test-next/integrations test-next/activities test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: translate GitHub evidence and human signals"
```

## Task 16: Port agent runners, prompts, transcripts, and workspaces

**Files:**

- Create: `src-next/execution/contracts/runner.ts`
- Create: `src-next/execution/infrastructure/runners/{claude,codex,cursor,registry}.ts`
- Create: `src-next/execution/infrastructure/{process-execution,transcripts}.ts`
- Create: `src-next/execution/infrastructure/workspace/{fake-workspace,git-workspace}.ts`
- Extend: `src-next/activities/agent/{agent-activity,agent-result}.ts`
- Create: `test-next/execution/{claude-runner,codex-runner,cursor-runner,runner-registry,transcripts,git-workspace}.test.ts`
- Create: `test-next/e2e/scenarios/agent-workspace.test.ts`

- [ ] **Step 1: Define target runner contracts before copying transports**

```ts
export interface RunnerRequest {
  readonly runId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly workspacePath?: string;
  readonly allowedTools: readonly string[];
  readonly resumeSessionId?: string;
}

export interface RunnerResult {
  readonly transport: 'succeeded' | 'failed' | 'cancelled' | 'ambiguous';
  readonly output: string;
  readonly runner: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly tokenUsage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly costUsd?: number;
  };
  readonly failure?: { readonly kind: string; readonly message: string };
}

export interface RunnerExecution {
  readonly identity?: {
    readonly kind: 'process' | 'remote-session';
    readonly id: string;
    readonly startedAt: string;
  };
  readonly result: Promise<RunnerResult>;
  cancel(reason: string): Promise<void>;
}

export interface Runner {
  start(request: RunnerRequest, signal: AbortSignal): Promise<RunnerExecution>;
}
```

No Work projection, WakeConfig, repository, issue number, or workflow
transition appears.

- [ ] **Step 2: Port accepted transport tests**

Copy and retarget:

```powershell
Copy-Item test/adapters/claude-runner.test.ts test-next/execution/claude-runner.test.ts
Copy-Item test/adapters/codex-runner.test.ts test-next/execution/codex-runner.test.ts
Copy-Item test/adapters/cursor-runner.test.ts test-next/execution/cursor-runner.test.ts
Copy-Item test/adapters/runner-registry.test.ts test-next/execution/runner-registry.test.ts
Copy-Item test/adapters/runner-transcripts.test.ts test-next/execution/transcripts.test.ts
Copy-Item test/adapters/git-workspace-manager.test.ts test-next/execution/git-workspace.test.ts
```

Keep command construction, structured output, token usage, session resume,
failure classification, cancellation, transcript retention, git isolation,
dirty-state, upstream, and cleanup cases. Remove tests that assert legacy
global input shapes.

- [ ] **Step 3: Run and confirm missing transports**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution/claude-runner.test.ts
```

Expected: FAIL resolving target runner implementation.

- [ ] **Step 4: Copy transport mechanics into their final owner**

Use the legacy runner/process/workspace implementations as algorithmic
evidence, but rewrite their public boundary to the contracts above. No copied
file may import from `src/**`.

Runner registry resolves an Execution-owned tier into an ordered runner list
and records the selected runner on the Run. Quota/failure policy does not live
in the registry.

Git workspace resolution consumes a canonical repository Resource with an
adapter-owned clone locator supplied through a narrow resolver port. Branch
names derive from WorkItem ID plus a safe objective slug, not issue number.

- [ ] **Step 5: Implement AgentActivity handler**

The handler:

1. renders its Activity-owned prompt input;
2. asks Execution for the already-resolved workspace path;
3. starts the selected Runner and reports its execution identity through the
   ActivityExecutionContext;
4. awaits the RunnerExecution result;
5. maps transport failure to `failed` or `ambiguous`;
6. parses and validates structured Wake output;
7. reports Resource candidates as untrusted evidence;
8. returns an ActivityOutcome.

It cannot append Orchestration or Resource events directly.

- [ ] **Step 6: Add `E2E-EXEC-001`**

```text
Given implement requires a branch workspace and a fake agent runner
When  advanceOnce executes implement
Then  execution.run-started names the workspace lease
  And the runner receives only its prompt, tools, model, and workspace
  And execution.run-succeeded contains a validated done outcome
  And the workspace is released
```

Add no-workspace and read-only variants.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution test-next/e2e/scenarios/agent-workspace.test.ts
npm run verify:next
npm test -- test/adapters/claude-runner.test.ts test/adapters/codex-runner.test.ts test/adapters/git-workspace-manager.test.ts
```

Expected: target runner/workspace suite and selected legacy evidence PASS.

```powershell
git add src-next/execution src-next/activities test-next/execution test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: port target agent execution capabilities"
```

## Task 17: Add workflow waits, policy retries, and supplemental commands

**Files:**

- Extend: `src-next/orchestration/contracts/{config,events,views}.ts`
- Extend: `src-next/orchestration/domain/{compiler,interpreter,workflow-instance}.ts`
- Extend: `src-next/orchestration/application/orchestration-service.ts`
- Create: `src-next/orchestration/application/signal-reactor.ts`
- Create: `test-next/orchestration/{retry-policy,signals,supplemental-activity}.test.ts`
- Create: `test-next/e2e/scenarios/{blocked-reply,retry-boundary,supplemental-command}.test.ts`

- [ ] **Step 1: Write retry-boundary tests**

Cover:

```ts
it('creates a new activation and Run when Orchestration retry policy permits');
it('does not retry an outcome marked requires-reconciliation');
it('follows the configured route after retry.max is exhausted');
it('does not let a human reply reset the retry count');
it('accepts one matching signal while waiting and ignores duplicates');
```

- [ ] **Step 2: Write supplemental-command tests**

Cover:

```ts
it('queues a configured supplemental Activity behind an active Run');
it('returns to the same primary stage after a supplemental Activity completes');
it('rejects an unknown or unauthorised command');
it('does not allow a supplemental command to bypass a blocked destructive gate');
```

- [ ] **Step 3: Run and confirm missing policy semantics**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration/retry-policy.test.ts test-next/orchestration/supplemental-activity.test.ts
```

Expected: FAIL because retry counts and supplemental activations are absent.

- [ ] **Step 4: Extend WorkflowInstance state**

Add:

```ts
readonly retryCounts: Readonly<Record<string, number>>;
readonly waitingFor?: {
  readonly signalKind: string;
  readonly resourceId?: ResourceId;
  readonly revision?: string;
};
readonly supplementalQueue: readonly {
  activity: string;
  input: unknown;
  requestedBy: string;
}[];
```

Retry keys are `${stageName}:${outcomeKind}`. A retry creates a new activation
ordinal. Execution never repeats a Run on its own.

- [ ] **Step 5: Implement signal and supplemental APIs**

```ts
waitForSignal(instanceId, expectation, context): Promise<WorkflowInstanceView>;
acceptSignal(instanceId, signal, context): Promise<WorkflowInstanceView>;
requestSupplementalActivity(instanceId, request, context): Promise<WorkflowInstanceView>;
```

Signal acceptance validates kind, Resource, revision, actor decision evidence,
and provider event idempotency before appending. Supplemental Activities are
sequential and cannot execute concurrently with the primary activation.

Compile configured custom commands into validated supplemental Activity
requests at bootstrap. Do not create a second global command policy engine.

- [ ] **Step 6: Add E2E scenarios**

`E2E-ORCH-RETRY-001`: failed safe outcome creates Run attempt 2; attempt 1 is
unchanged; count survives restart.

`E2E-ORCH-WAIT-001`: blocked Activity waits; an accepted human reply requests a
new activation without resetting its retry/group budget.

`E2E-ORCH-COMMAND-001`: `/codereview` becomes a provider-neutral supplemental
review Activity, completes, and leaves the primary stage unchanged. Any
communication-oriented custom command receives an explicit catalogue
disposition and is not used to introduce a general communication Activity.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration test-next/e2e/scenarios/blocked-reply.test.ts test-next/e2e/scenarios/retry-boundary.test.ts test-next/e2e/scenarios/supplemental-command.test.ts
npm run verify:next
npm test -- test/core/policy-engine.test.ts test/core/tick-runner.quota.test.ts
```

Expected: target policy scenarios and selected legacy policy evidence PASS.

```powershell
git add src-next/orchestration test-next/orchestration test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: add target workflow wait and retry policy"
```

## Task 18: Model child workflows and eliminate watcher loops

**Files:**

- Extend: `src-next/orchestration/contracts/{config,events,views}.ts`
- Extend: `src-next/orchestration/domain/{compiler,interpreter,workflow-instance}.ts`
- Create: `src-next/orchestration/application/watch-reactor.ts`
- Extend: `src-next/orchestration/application/orchestration-service.ts`
- Create: `test-next/orchestration/{child-workflow,watch-reactor}.test.ts`
- Create: `test-next/e2e/scenarios/{child-completion,child-loop-guard}.test.ts`

- [ ] **Step 1: Write the regression scenario for the known loop**

Use `E2E-ORCH-LOOP-001`:

```text
Given parent implement waits while watcher pr-review may run
  And pr-review returns done
  And parent state still satisfies the watcher condition
When  advance is called repeatedly
Then  one trigger event creates at most one child instance
  And child completion is consumed once
  And success does not reset the orchestration-group dispatch budget
  And repeated causal activation blocks instead of looping
```

- [ ] **Step 2: Run and confirm child semantics are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/e2e/scenarios/child-loop-guard.test.ts
```

Expected: FAIL because watch/child contracts are absent.

- [ ] **Step 3: Add explicit watch configuration**

```ts
export interface WatchConfig {
  readonly id: string;
  readonly while: {
    readonly stages: readonly string[];
    readonly statuses: readonly ('active' | 'waiting' | 'blocked')[];
  };
  readonly on?: { readonly events: readonly string[] };
  readonly schedule?: { readonly cron: string };
  readonly workflow: string;
  readonly maxPerGroup: number;
}
```

A watch declares at least `on` or `schedule`. Compiler validation requires
known stage/workflow names, positive `maxPerGroup`, canonical event names, and
no duplicate watch IDs.

- [ ] **Step 4: Add child/group events and view fields**

Events:

```text
orchestration.child-requested
orchestration.child-started
orchestration.child-completed
orchestration.child-completion-consumed
orchestration.causal-activation-rejected
orchestration.group-budget-exhausted
```

Every child records parent instance, watch ID, trigger event/slot ID, group ID,
and causal-cycle ID. Stable child request ID:

```text
<parent-instance>:watch:<watch-id>:trigger:<event-or-slot-id>
```

The WorkItem retains one primary active WorkflowInstance reference. Subordinate
children exist only through their parent/group links.

- [ ] **Step 5: Implement WatchReactor**

For each canonical event or durable schedule slot:

1. find compiled watches matching the event;
2. load the parent public view;
3. check stage/status;
4. derive the stable child request ID;
5. check group-wide count and causal history;
6. request the child idempotently;
7. checkpoint the trigger only after request append succeeds.

Child success never decrements or resets counts. A child completion is accepted
by the parent once.

- [ ] **Step 6: Add a normal child-completion scenario**

`E2E-ORCH-CHILD-001` proves a child can complete, deliver one typed signal to
its parent, and allow the parent to progress without becoming a second primary
workflow.

- [ ] **Step 7: Pass Packet C orchestration gate**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/orchestration test-next/e2e/scenarios/child-completion.test.ts test-next/e2e/scenarios/child-loop-guard.test.ts
npm run check:catalogue
npm run verify:next
npm run verify
```

Expected: child success and loop regression scenarios PASS; all verification
commands PASS.

- [ ] **Step 8: Commit child safety**

```powershell
git add src-next/orchestration test-next/orchestration test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: bound target child workflow activation"
```

## Task 19: Model pull-request state and revision-bound review authority

**Files:**

- Create: `src-next/activities/pr/{contracts,policy}.ts`
- Extend: `src-next/integrations/github/application/inbound-translator.ts`
- Modify: `src-next/activities/index.ts`
- Modify: `src-next/activities/module.json`
- Create: `test-next/activities/{pr-policy,pr-projection}.test.ts`
- Create: `test-next/e2e/scenarios/{pr-correlation,stale-approval}.test.ts`

- [ ] **Step 1: Write pull-request policy tests**

Cover:

```ts
it('projects provider-neutral pull-request state from integration commands');
it('binds accepted review evidence to the observed head revision');
it('invalidates approval when the head revision changes');
it('rejects review evidence for an uncorrelated pull request');
it('rejects a primary correlation conflict');
it('rejects missing or multiple primary pull-request resources');
it('distinguishes checks pending, passing, and failing');
```

- [ ] **Step 2: Run and confirm specialist PR contracts are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities/pr-policy.test.ts
```

Expected: FAIL resolving PR contracts.

- [ ] **Step 3: Define the specialist PR view**

```ts
export interface PullRequestView {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly checks: 'unknown' | 'pending' | 'passing' | 'failing';
  readonly acceptedReview?: {
    readonly revision: string;
    readonly actorId: string;
    readonly acceptedEventId: string;
  };
}
```

Commands:

```text
pr.observe
pr.accept-review-signal
pr.request-changes-signal
```

Events:

```text
pr.discovered
pr.revision-changed
pr.state-changed
pr.checks-changed
pr.review-accepted
pr.review-changes-requested
pr.review-rejected
```

Update `activities/module.json` event namespaces to
`["activities.", "pr.", "review."]`.

- [ ] **Step 4: Implement pure authority policy**

```ts
export type PullRequestAuthorityDecision =
  | { readonly allowed: true; readonly resourceId: ResourceId; readonly revision: string }
  | {
      readonly allowed: false;
      readonly reason:
        | 'missing-resource'
        | 'ambiguous-resource'
        | 'correlation-conflict'
        | 'closed'
        | 'stale-approval'
        | 'checks-pending'
        | 'checks-failing'
        | 'untrusted-actor';
    };
```

The policy receives only public Work, Resource, PR, and accepted-signal views.
It performs no provider query or append.

- [ ] **Step 5: Translate GitHub PR evidence into commands**

InboundTranslator maps GitHub PR observations to `pr.observe` and Resource
commands. Only PR application policy emits canonical `pr.*` facts. A head SHA
change appends `pr.revision-changed` even when title/body are unchanged.
Export the pure PR view fold as projection namespace `activities-pr` and
register it with ProjectionRunner.

- [ ] **Step 6: Add scenarios**

`E2E-PR-001`: a verified primary PR correlation creates a specialist PR view;
an uncorrelated or conflicting reported artifact cannot affect the WorkItem.

`E2E-PR-002`:

```text
Given pr.discovered revision A
  And pr.review-accepted revision A
When  pr.revision-changed revision B
  And activity.requested pr.merge
Then  pr.merge-denied reason stale-approval
  And orchestration.instance-blocked
  And not pr.merge-requested
```

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities test-next/e2e/scenarios/pr-correlation.test.ts test-next/e2e/scenarios/stale-approval.test.ts
npm run verify:next
npm test -- test/adapters/github-artifact-verifier.test.ts test/core/tick-runner.approval.test.ts
```

Expected: target PR authority and selected legacy correlation/approval evidence
PASS.

```powershell
git add src-next/activities src-next/integrations test-next/activities test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: bind target PR authority to revisions"
```

## Task 20: Implement `pr.approve` and `pr.merge` Activities

**Files:**

- Create: `src-next/activities/pr/{approve,merge}.ts`
- Extend: `src-next/activities/pr/contracts.ts`
- Extend: `src-next/activities/pr/policy.ts`
- Create: `test-next/activities/{pr-approve,pr-merge}.test.ts`
- Create: `test-next/e2e/scenarios/{pr-approval,pr-merge}.test.ts`

- [ ] **Step 1: Write Activity tests**

Cover:

```ts
it('pr.approve requires exactly one primary approvable PR');
it('pr.approve emits a provider-neutral intent for the current revision');
it('pr.merge requires exactly one primary mergeable PR');
it('pr.merge denies stale approval before emitting any intent');
it('pr.merge denies pending or failing required checks');
it('pr.merge emits one provider-neutral intent when every gate passes');
it('neither Activity receives a GitHub client or token');
```

- [ ] **Step 2: Run and confirm handlers are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities/pr-merge.test.ts
```

Expected: FAIL resolving `pr.merge`.

- [ ] **Step 3: Define Activity inputs and outcomes**

```ts
export interface PullRequestTargetInput {
  readonly target: 'primary' | { readonly resourceId: ResourceId };
}

export interface PullRequestApproveInput extends PullRequestTargetInput {
  readonly body?: string;
}

export interface PullRequestMergeInput extends PullRequestTargetInput {
  readonly method: 'merge' | 'squash' | 'rebase';
  readonly requireChecks: boolean;
}

export type PullRequestActivityOutcome =
  | {
      readonly kind: 'waiting';
      readonly data: { readonly intentEventId: string; readonly signalKind: 'delivery-result' };
    }
  | { readonly kind: 'done'; readonly data: { readonly deliveryEventId: string } }
  | { readonly kind: 'blocked'; readonly data: { readonly reason: string } }
  | { readonly kind: 'failed'; readonly data: { readonly reason: string } };
```

Zod schemas are strict. Default target is `primary`; merge method has no
implicit default unless bootstrap configuration supplies one.

- [ ] **Step 4: Implement deterministic handlers**

Both handlers:

1. resolve Resource cardinality from the invocation;
2. load the specialist PR view;
3. evaluate pure authority policy;
4. on denial, append a `pr.approve-denied` or `pr.merge-denied` fact and return
   `blocked`;
5. on approval, append `pr.approve-requested` or `pr.merge-requested` containing
   activation ID, Resource ID, exact revision, method/body, and stable
   idempotency key;
6. return `waiting` for a delivery result with the intent event ID.

They never call GitHub. A Run sentinel alone never satisfies policy.
Orchestration must not complete the follow-on Activity or transition the
workflow until Task 21 translates a confirmed delivery into its final `done`
outcome. Definite failure becomes `failed`; unresolved ambiguity remains
waiting.

- [ ] **Step 5: Add safe and denied scenarios**

`E2E-PR-APPROVE-001`: accepted revision A produces one approval intent for A.

`E2E-PR-MERGE-001`: verified resource, accepted revision, and passing checks
produce one merge intent with configured method and leave the Activity waiting
for delivery.

`E2E-PR-MERGE-002`: missing, ambiguous, stale, conflicting, closed, pending,
failing, and unauthorised variants each block without `pr.merge-requested`.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities test-next/e2e/scenarios/pr-approval.test.ts test-next/e2e/scenarios/pr-merge.test.ts
npm run verify:next
npm test -- test/adapters/github-pull-request-merge-actor.test.ts test/core/tick-runner.approval.test.ts
```

Expected: target PR Activity matrix and selected legacy merge evidence PASS.

```powershell
git add src-next/activities test-next/activities test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: add safe target PR Activities"
```

## Task 20A: Establish strong-contract primitives and executable rules

> **Corrective gate:** Tasks 20A-20E supersede any earlier plan examples that
> use raw canonical event names, raw stream kinds, erased event payloads, or
> unconstrained machine strings. Do not begin Task 21 until all five tasks pass
> `npm run verify:next`.

**Design authority:**
[`docs/superpowers/specs/2026-07-31-wake-strong-contracts-design.md`](../specs/2026-07-31-wake-strong-contracts-design.md)

**Files:**

- Modify: `src-next/kernel/contracts/{events,identifiers}.ts`
- Modify: `src-next/kernel/domain/event-envelope.ts`
- Create: `src-next/kernel/contracts/vocabulary.ts`
- Modify: `src-next/kernel/index.ts`
- Create: `scripts/lib/contract-vocabulary.mjs`
- Create: `scripts/check-contract-vocabulary.mjs`
- Create: `test-next/architecture/contract-vocabulary.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing kernel and checker tests**

Add kernel assertions proving a stream ID retains its brand and an event union
retains its exact event/payload/stream relationship through
`createEventDraft()`. Use an `interface` payload map, not only a type alias.
Add checker fixture tests:

```ts
it('rejects a registered event literal outside its owning events contract');
it('rejects a registered stream literal outside its owning streams contract');
it('rejects a repeated defineClosedVocabulary value');
it('rejects unsupported indirect, shorthand, spread, and computed catalogue declarations');
it('permits provider decoding, persistence keys, free text, and corrupt-input fixtures');
```

The checker tests create disposable fixture trees beneath `os.tmpdir()` and
invoke the exported `checkContractVocabulary(root)` function. They assert
diagnostics containing relative path, line, offending value, and replacement
catalogue owner.

- [ ] **Step 2: Run tests and confirm the contracts/checker are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/kernel test-next/architecture/contract-vocabulary.test.ts
```

Expected: FAIL resolving `EventUnion`, the two-parameter `EntityRef`, or
`scripts/lib/contract-vocabulary.mjs`.

- [ ] **Step 3: Add generic strong-contract primitives**

Implement:

```ts
// kernel/contracts/vocabulary.ts
export type ValueOf<Catalogue extends Readonly<Record<string, unknown>>> =
  Catalogue[keyof Catalogue];

export const defineClosedVocabulary = <
  const Catalogue extends Readonly<Record<string, string>>,
>(
  catalogue: Catalogue,
): Catalogue => catalogue;

// kernel/contracts/identifiers.ts
export interface EntityRef<
  Kind extends string = string,
  Id extends string = string,
> {
  readonly kind: Kind;
  readonly id: Id;
}

export function entityRef<Kind extends string, Id extends string>(
  kind: Kind,
  id: Id,
): EntityRef<Kind, Id> {
  if (id.trim().length === 0) throw new Error('Entity reference id must not be empty');
  return { kind, id };
}

// kernel/contracts/events.ts
export interface EventDraft<
  Type extends string = string,
  Payload = unknown,
  Stream extends EntityRef = EntityRef,
> {
  // retain the existing metadata fields
  readonly eventType: Type;
  readonly stream: Stream;
  readonly payload: Payload;
}

export interface EventEnvelope<
  Type extends string = string,
  Payload = unknown,
  Stream extends EntityRef = EntityRef,
> extends EventDraft<Type, Payload, Stream> {
  readonly recordedAt: string;
  readonly sequence: number;
  readonly globalPosition: number;
}

export type EventUnion<
  Payloads extends object,
  Stream extends EntityRef,
> = {
  [Type in keyof Payloads & string]: EventEnvelope<Type, Payloads[Type], Stream>;
}[keyof Payloads & string];

export type EventDraftUnion<
  Payloads extends object,
  Stream extends EntityRef,
> = {
  [Type in keyof Payloads & string]: EventDraft<Type, Payloads[Type], Stream>;
}[keyof Payloads & string];
```

Existing kernel and persistence defaults remain generic. Do not add a domain
registry to `kernel`.

- [ ] **Step 4: Preserve exact streams through the public draft factory**

Thread `Stream extends EntityRef` through `EventDraftInput` and
`createEventDraft()` in `kernel/domain/event-envelope.ts`:

```ts
export interface EventDraftInput<
  Type extends string,
  Payload,
  Stream extends EntityRef,
> extends Omit<EventDraft<Type, Payload, Stream>, 'schemaVersion'> {}

export function createEventDraft<
  Type extends string,
  Payload,
  Stream extends EntityRef,
>(input: EventDraftInput<Type, Payload, Stream>): EventDraft<Type, Payload, Stream>;
```

The compile-only test must fail if the returned stream loses its exact kind or
branded ID.

- [ ] **Step 5: Implement the deliberately small AST vocabulary checker**

Use the TypeScript parser for syntax traversal, not regular expressions and
not a TypeScript `Program`/`TypeChecker`. The checker must:

1. recursively parse the supplied `src-next/**/*.ts` tree;
2. recognize only directly exported, inline event/stream catalogue objects and
   `defineClosedVocabulary({ ... } as const)` closed catalogues;
3. require ordinary property assignments with string-literal values;
4. reject indirect exports, identifier/spread arguments, computed properties,
   shorthand properties, and other unsupported shapes rather than ignoring
   them;
5. reject an exact registered value outside its declaration initializer;
6. permit registered values only in exact integration
   `*-decoder.ts|*-translator.ts|*-translation.ts` paths, persistence paths,
   and `*.corrupt-fixture.ts`;
7. support optional rules
   `closed-vocabulary,event-literals,stream-literals`;
8. reject empty/unknown rule selections with concise usage output;
9. sort with a locale-independent code-unit comparator.

Do not implement symbol resolution, event-type inference, payload provenance,
function-name permissions, source-level `entityRef` detection, or generic
event analysis. TypeScript, public exports, dependency rules, and ESLint own
those concerns.

`scripts/check-contract-vocabulary.mjs` calls the library for `src-next` and
exits non-zero on diagnostics. Do not add a baseline, suppression file, or list
of current violations.

- [ ] **Step 6: Keep the checker executable but defer the root gate**

Add:

```json
"lint:contracts": "node scripts/check-contract-vocabulary.mjs"
```

Do not add it to `lint:architecture` until Task 20E because Tasks 20B-20D remove
the violations it is designed to expose.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/kernel test-next/architecture/contract-vocabulary.test.ts
npm run build:next
```

Expected: strong generic contracts and all checker fixture tests PASS.

```powershell
git add src-next/kernel scripts/check-contract-vocabulary.mjs scripts/lib/contract-vocabulary.mjs test-next/architecture/contract-vocabulary.test.ts package.json
git commit -m "refactor: establish strong contract primitives"
```

## Task 20B: Replace raw logical streams with typed domain identities

**Files:**

- Create: `src-next/work/contracts/streams.ts`
- Create: `src-next/resources/contracts/streams.ts`
- Create: `src-next/activities/contracts/streams.ts`
- Create: `src-next/orchestration/contracts/streams.ts`
- Create: `src-next/execution/contracts/streams.ts`
- Create: `src-next/integrations/contracts/streams.ts`
- Modify: `src-next/{work,resources,activities,orchestration,execution,integrations}/index.ts`
- Modify: `src-next/{work,resources,activities,orchestration,execution,integrations}/module.json`
- Modify: every `src-next` caller of `entityRef()` or raw `stream.kind`
- Modify: `scripts/check-module-manifests.mjs`
- Modify: `test-next/architecture/module-manifests.test.ts`
- Create: `test-next/architecture/stream-contracts.test.ts`
- Modify: affected Work, Resource, PR, Orchestration, Execution, and integration tests

- [ ] **Step 1: Write failing stream ownership and regression tests**

Assert:

```ts
it('gives every logical stream kind exactly one manifest owner');
it('constructs WorkItem streams only from WorkItemId');
it('constructs Resource, Run, WorkflowInstance, integration, coordination, and Activity-decision streams through their owners');
it('hides composite coordination and Activity-decision keys behind named constructors');
it('records a PR denial on the canonical work-item stream rather than a new work stream');
```

The final regression must expose the current accidental difference between
`'work'` and `'work-item'`.

- [ ] **Step 2: Run and confirm stream contracts are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/architecture/stream-contracts.test.ts test-next/activities/pr-approve.test.ts test-next/activities/pr-merge.test.ts
```

Expected: FAIL resolving the owned stream constructors or observing the
non-canonical denial stream.

- [ ] **Step 3: Define domain-owned stream catalogues and constructors**

Use this pattern in each `contracts/streams.ts`:

```ts
export const WorkStreamKind = {
  WorkItem: 'work-item',
} as const;

export type WorkItemStreamRef = EntityRef<
  typeof WorkStreamKind.WorkItem,
  WorkItemId
>;

export const workItemStream = (id: WorkItemId): WorkItemStreamRef =>
  ({ kind: WorkStreamKind.WorkItem, id });

export const isWorkItemStream = (stream: EntityRef): stream is WorkItemStreamRef =>
  stream.kind === WorkStreamKind.WorkItem;
```

The exact owned kinds are:

| Owner | Kind | Constructor |
| --- | --- | --- |
| `work` | `work-item` | `workItemStream(WorkItemId)` |
| `resources` | `resource` | `resourceStream(ResourceId)` |
| `activities` | `activity-decision` | `activityDecisionStream(ActivationId, PrAction)` |
| `orchestration` | `workflow-instance` | `workflowInstanceStream(WorkflowInstanceId)` |
| `orchestration` | `orchestration-group` | `primaryOrchestrationGroupStream(WorkItemId)` and an internal validated group-key constructor |
| `execution` | `run` | `runStream(RunId)` |
| `integrations` | `integration` | `integrationStream(AdapterId)` |

Add missing ID brands before using them. Built-in GitHub code uses a public
branded `GitHubAdapterId` constant through `integrationStream`.

After migration, remove `entityRef` from `kernel/index.ts`. It may remain an
internal kernel implementation/test helper, but no domain module can import it
through the public boundary.

- [ ] **Step 4: Declare and verify stream ownership**

Add an exact `streams` array beside `events`, `config`, and `relations` in
every module manifest, including an empty array where the module owns none.
Update both manifest checks to require arrays, reject duplicate owners, and
ensure every exported `*StreamKind` value is declared by the same module.

- [ ] **Step 5: Migrate all production stream construction and matching**

Replace every direct call and comparison in `src-next`. Repositories, event
factories, projectors, policies, and integration pollers use their owning
constructors/predicates. Remove `workStream()` from
`activities/pr/activity-support.ts`; PR denial uses `workItemStream()`.

After migration this command must print only the internal kernel definition:

```powershell
rg -n "entityRef\(" src-next
```

Expected locations:

```text
src-next/kernel/contracts/identifiers.ts
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/architecture test-next/work test-next/resources test-next/activities test-next/orchestration test-next/execution test-next/integrations
npm run lint:contracts -- --rules stream-literals
npm run verify:next
```

The scoped checker must report no stream-literal violation. Public-export and
dependency tests prove low-level stream construction is unavailable. Do not
run it with a baseline for the remaining event work.

```powershell
git add src-next test-next/architecture test-next/work test-next/resources test-next/activities test-next/orchestration test-next/execution test-next/integrations scripts/check-module-manifests.mjs
git commit -m "refactor: type logical stream identities"
```

## Task 20C: Type canonical events and decode persisted payloads

**Files:**

- Create: `src-next/kernel/contracts/event-schema.ts`
- Modify: `src-next/kernel/{index.ts,domain/event-envelope.ts}`
- Modify: `src-next/persistence/filesystem/file-event-journal.ts`
- Modify: every `src-next/**/contracts/events.ts`
- Modify: event factories under `src-next/{work,resources,activities,orchestration,execution,integrations}`
- Modify: folds, repositories, projectors, and reactors that consume events
- Create: `test-next/kernel/event-decoding.test.ts`
- Modify: `test-next/persistence/file-event-journal.test.ts`
- Create: `test-next/{work,resources,activities,orchestration,execution,integrations}/event-contracts.test.ts`
- Modify: affected E2E scenario tests

- [ ] **Step 1: Write failing decoding and exhaustiveness tests**

For each owner assert:

```ts
it('decodes every declared event with its exact payload and stream');
it('rejects an owned event with an unknown type');
it('rejects an owned event with a malformed payload');
it('rejects an owned event on the wrong stream kind');
it('ignores an unrelated namespace in a projector selector');
```

Also assert that the filesystem journal rejects malformed JSON and malformed
common envelopes with file/line context rather than returning a cast value.

- [ ] **Step 2: Run and confirm persisted payloads are still erased**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/kernel/event-decoding.test.ts test-next/persistence/file-event-journal.test.ts test-next/work/event-contracts.test.ts
```

Expected: FAIL because common/domain decoders are absent and folds still accept
generic payloads.

- [ ] **Step 3: Add strict common-envelope decoding**

`kernel/contracts/event-schema.ts` owns strict Zod schemas for actor, source,
stream, draft metadata, and recorded envelope metadata. Export:

```ts
export function decodeEventEnvelope(input: unknown): EventEnvelope;
```

Validate non-empty IDs/types, `schemaVersion: 1`, ISO timestamp strings,
positive sequence/global position, and unknown payload. The filesystem journal
calls this function after `JSON.parse`; remove
`JSON.parse(line) as EventEnvelope`.

- [ ] **Step 4: Give every domain a catalogue, payload map, union, and decoder**

Use the Work pattern from the strong-contract design:

```ts
export const WorkEventType = {
  ItemCreated: 'work.item-created',
  ObjectiveRevised: 'work.objective-revised',
  ItemLinked: 'work.item-linked',
  ItemClosed: 'work.item-closed',
  ItemCancelled: 'work.item-cancelled',
} as const;

export interface WorkEventPayloads {
  readonly [WorkEventType.ItemCreated]: { readonly objective: string };
  readonly [WorkEventType.ObjectiveRevised]: { readonly objective: string };
  readonly [WorkEventType.ItemLinked]: WorkItemLinkedPayload;
  readonly [WorkEventType.ItemClosed]: WorkItemClosedPayload;
  readonly [WorkEventType.ItemCancelled]: WorkItemCancelledPayload;
}

export type WorkEvent = EventUnion<WorkEventPayloads, WorkItemStreamRef>;
export type WorkEventDraft = EventDraftUnion<WorkEventPayloads, WorkItemStreamRef>;

export function decodeWorkEvent(event: EventEnvelope): WorkEvent;
export function selectWorkEvent(event: EventEnvelope): WorkEvent | null;
```

Repeat with owner-specific names for Resources, Activities including PR/review,
Orchestration including child/group facts, Execution, and GitHub adapter
evidence. Zod schemas are strict and transform identifier strings through
their branded constructors.

`select*Event` returns `null` only outside the owner's declared namespace. It
throws for an unknown/malformed event inside that namespace.

- [ ] **Step 5: Migrate factories, folds, projectors, and reactors**

Event factories return exact draft union members. Domain folds accept exact
owned unions. Generic projection selectors decode before calling a fold.
Switches use catalogue values and an `assertNever()` exhaustiveness helper.

Remove:

- `EventDraft<string, unknown>` and `EventEnvelope<string, unknown>` from
  domain/application code;
- default generic `EventDraft[]`/`EventEnvelope[]` in domain repositories;
- `String(payload.*)`, `Number(payload.*)`, and payload assertions;
- raw canonical event names in production comparisons and construction.

The journal, audit query, projection runner, and adapter intake boundary remain
generic by design.

- [ ] **Step 6: Verify event architecture and behavior**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/kernel test-next/persistence test-next/work test-next/resources test-next/activities test-next/orchestration test-next/execution test-next/integrations test-next/e2e
npm run lint:contracts -- --rules event-literals,stream-literals
npm run verify:next
```

Expected: all domain event decoding and E2E tests PASS, with no event/stream
literal diagnostic. The unscoped checker may still report closed/open
vocabulary work explicitly assigned to Task 20D.

- [ ] **Step 7: Commit**

```powershell
git add src-next test-next
git commit -m "refactor: enforce typed event contracts"
```

## Task 20D: Type Activities, compiled workflows, Resources, and provider signals

**Files:**

- Modify: `src-next/activities/contracts/{activity,registry}.ts`
- Create: `src-next/activities/contracts/{identifiers,vocabulary}.ts`
- Modify: every Activity definition and invocation
- Modify: `src-next/orchestration/contracts/{config,identifiers,views,events}.ts`
- Modify: `src-next/orchestration/domain/{compiler,interpreter,workflow-instance,transition}.ts`
- Modify: `src-next/execution/contracts/{config,runner,views,workspace}.ts`
- Modify: `src-next/resources/contracts/{identifiers,views}.ts`
- Create: `src-next/resources/contracts/vocabulary.ts`
- Modify: `src-next/activities/review/{contracts,signals}.ts`
- Create: `src-next/integrations/github/application/review-command-translator.ts`
- Modify: `src-next/integrations/github/application/inbound-translator.ts`
- Create: `test-next/activities/activity-outcome-contracts.test.ts`
- Create: `test-next/orchestration/compiled-contracts.test.ts`
- Create: `test-next/resources/resource-vocabulary.test.ts`
- Create: `test-next/integrations/review-command-translator.test.ts`
- Modify: affected unit and E2E tests

- [ ] **Step 1: Write failing closed/open vocabulary tests**

Add:

```ts
it('retains an Activity-specific outcome through registration and execution');
it('rejects a workflow outcome route not declared by its Activity');
it('compiles stage, Activity, workflow, signal, and command names to branded identifiers');
it('compiles done and await-human to structural targets rather than stage strings');
it('rejects stages named with reserved terminal words');
it('uses one canonical retry-safety spelling');
it('registers extensible Resource kinds and capabilities while exposing constants for built-ins');
it('translates exact GitHub slash commands to canonical review decisions at the integration boundary');
it('does not let activities/review parse GitHub comment syntax');
```

- [ ] **Step 2: Run and confirm the contracts are currently open strings**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities/activity-outcome-contracts.test.ts test-next/orchestration/compiled-contracts.test.ts test-next/resources/resource-vocabulary.test.ts test-next/integrations/review-command-translator.test.ts
```

Expected: FAIL on missing branded names, structural targets, registries, or
boundary translator.

- [ ] **Step 3: Make Activity input and outcome generic end-to-end**

Implement:

```ts
export interface ActivityDefinition<
  Name extends ActivityName,
  Input,
  Outcome extends ActivityOutcome,
> {
  readonly name: Name;
  readonly inputSchema: z.ZodType<Input>;
  readonly outcomeSchema: z.ZodType<Outcome>;
  readonly outcomeKinds: readonly Outcome['kind'][];
  readonly resources: readonly ResourceRequirement[];
  readonly executionKind: ActivityExecutionKind;
  readonly handler: ActivityHandler<Input, Outcome>;
}

export interface ActivityHandler<Input, Outcome extends ActivityOutcome> {
  execute(
    invocation: ActivityInvocation<Input>,
    context: ActivityExecutionContext,
  ): Promise<Outcome>;
}
```

Use `ActivityName`, built-in Activity constants, and a registry-owned erased
internal entry only where heterogeneous storage requires it. Public validation
of a resolved definition preserves that definition's input/outcome type.
Registration verifies unique `outcomeKinds` and that sample/returned outcomes
are accepted by the schema.

- [ ] **Step 4: Compile open names and structural transition targets**

Add brands and validators for workflow, stage, signal, command, activation,
workflow-instance, and orchestration-group identities. Keep raw strings only
in strict configuration schemas.

Compile route targets to:

```ts
export const TransitionTargetKind = {
  Stage: 'stage',
  Complete: 'complete',
  AwaitSignal: 'await-signal',
} as const;

export type TransitionTarget =
  | { readonly kind: typeof TransitionTargetKind.Stage; readonly stage: StageName }
  | { readonly kind: typeof TransitionTargetKind.Complete }
  | { readonly kind: typeof TransitionTargetKind.AwaitSignal };
```

The compiler resolves every Activity, validates route keys against
`outcomeKinds`, rejects reserved stage names, and returns only compiled
contracts. Interpreter code never compares a target with `'done'` or
`'await-human'`.

- [ ] **Step 5: Catalogue closed machine vocabularies**

Create domain-owned `defineClosedVocabulary({ ... } as const)` catalogues and
derived types for current closed values including Activity execution
kind/cardinality/role, workflow/Run status, retry safety, workspace mode,
PR/check/review/delivery state, merge method, actor/source kind, and machine
denial/failure codes.

Do not force open Activity, Resource, adapter, workflow, stage, command, or
signal names into closed global unions. Give those brands, validators,
registries, and built-in constants.

- [ ] **Step 6: Move GitHub comment conventions to the integration**

`review-command-translator.ts` recognizes only normalized, exact GitHub
commands such as `/accepted` and `/changes` according to current approved
behavior and returns canonical typed review-decision candidates.
`activities/review` retains authorization and decision contracts but removes
comment text parsing. Other integrations can translate different conventions
to the same canonical decision without importing GitHub.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities test-next/orchestration test-next/resources test-next/execution test-next/integrations test-next/e2e
npm run lint:contracts
npm run verify:next
```

Expected: typed Activity/workflow/resource/integration contracts and all
existing behavior PASS.

```powershell
git add src-next test-next
git commit -m "refactor: type domain vocabularies and workflow contracts"
```

## Task 20E: Decompose orchestration seams and enable the contract gate

**Files:**

- Split: `src-next/orchestration/application/orchestration-service.ts`
- Split: `src-next/orchestration/domain/interpreter.ts`
- Split: `src-next/orchestration/domain/workflow-instance.ts`
- Modify: `src-next/orchestration/index.ts`
- Modify: `src-next/orchestration/MODULE.md`
- Modify: `eslint.config.js`
- Modify: `package.json`
- Modify: orchestration unit and E2E tests only where imports move
- Modify: `test-next/architecture/contract-vocabulary.test.ts`

- [ ] **Step 1: Add characterization tests for public orchestration seams**

Using only public Orchestration contracts/services, retain tests for:

```ts
it('starts one primary WorkflowInstance');
it('requests and accepts one typed Activity outcome');
it('waits for and accepts a typed signal');
it('retries without resetting the group budget');
it('coordinates a child without a parent-child success loop');
it('replays the same event sequence to the same public view');
```

Run them before moving code and confirm they PASS.

- [ ] **Step 2: Split by decision and use case without changing public behavior**

Application files become focused use cases:

```text
orchestration/application/
  start-workflow.ts
  advance-workflow.ts
  accept-activity-outcome.ts
  accept-signal.ts
  request-child.ts
  coordination-claims.ts
  group-budget-recorder.ts
  orchestration-repository.ts
  orchestration-service.ts       # thin compatibility facade/public composition
```

Domain files become pure decisions:

```text
orchestration/domain/
  workflow-instance.ts           # state and top-level exhaustive fold only
  workflow-instance-events.ts    # typed event application
  activation-policy.ts
  retry-policy.ts
  signal-policy.ts
  supplemental-policy.ts
  child-policy.ts
  transition.ts
  interpreter.ts                 # small dispatcher over the policies
```

No extracted file imports journal, clock, adapter, or execution
infrastructure. Do not introduce a generic process manager or service locator.

- [ ] **Step 3: Ratchet comprehensibility limits**

Reduce the `src-next` `max-lines` limit from 400 to 300 and
`max-lines-per-function` from 100 to 80. If a non-generated file fails, split
it by responsibility; do not add path exceptions. Keep complexity at 12 and
depth at 4 unless the existing limit is already stricter.

- [ ] **Step 4: Enable deterministic contract enforcement**

Add an ESLint override for
`src-next/{work,resources,activities,orchestration,execution}/{domain,application}/**/*.ts`
that:

- uses `no-restricted-imports` to prohibit the named kernel imports
  `EventDraft`, `EventEnvelope`, and `entityRef`; domain/application files use
  owned event unions and stream constructors instead;
- uses `no-restricted-syntax` to prohibit call expressions whose identifier
  callee is `String` or `Number`.

The restriction intentionally also rejects local functions shadowing
`String`/`Number`; those names are misleading in domain code. Add focused
architecture fixtures proving aliased restricted imports fail and contract,
integration-boundary, persistence, and test files remain permitted.

Change:

```json
"lint:architecture": "node scripts/check-module-manifests.mjs && node scripts/check-contract-vocabulary.mjs && depcruise --config dependency-cruiser.config.mjs src-next"
```

Run the checker and ESLint with no baseline, ignored current violation, or
broad path suppression. Provider/persistence/config exceptions must be exact
structural rules already covered by checker tests.

- [ ] **Step 5: Update module policy**

Update `orchestration/MODULE.md` with:

- compiled strings stop at the compiler;
- decisions consume typed state/input and return typed event drafts;
- use cases own I/O sequencing;
- the service facade delegates and contains no policy;
- child/group, retry, signal, and supplemental policies remain independent;
- persisted events are decoded before folding.

- [ ] **Step 6: Verify the corrective gate and commit**

Run:

```powershell
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
```

Expected: no vocabulary, dependency, size, unused-export, build, or test
failure.

```powershell
git add src-next/orchestration test-next/orchestration test-next/e2e test-next/architecture scripts eslint.config.js package.json
git commit -m "refactor: enforce typed orchestration seams"
```

## Task 21: Deliver external effects from the journal

**Files:**

- Create: `src-next/integrations/delivery/contracts/{commands,config,events,views}.ts`
- Create: `src-next/integrations/delivery/application/{delivery-outcome-reactor,delivery-projector,delivery-service}.ts`
- Create: `src-next/integrations/github/application/outbound-translator.ts`
- Create: `src-next/integrations/github/infrastructure/delivery.ts`
- Extend: `src-next/integrations/fake/external-sink.ts`
- Create: `test-next/integrations/{delivery-projector,delivery-service,github-delivery}.test.ts`
- Create: `test-next/e2e/scenarios/{outbox-crash,pr-merge-delivery}.test.ts`

- [ ] **Step 1: Write durable-delivery tests**

Cover:

```ts
it('projects unresolved intent event positions without copying payload authority');
it('uses the canonical intent event id as provider idempotency key');
it('records confirmed delivery once');
it('records definite provider failure');
it('records sent-but-unconfirmed as ambiguous');
it('reconciles an ambiguous delivery before retrying');
it('rebuilds unresolved delivery work from the central journal');
it('completes the originating Activity only after confirmed delivery');
```

- [ ] **Step 2: Run and confirm delivery capability is absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/integrations/delivery-service.test.ts
```

Expected: FAIL resolving delivery contracts.

- [ ] **Step 3: Define delivery contracts**

```ts
export interface DeliveryIntentView {
  readonly intentEventId: string;
  readonly globalPosition: number;
  readonly kind: 'pr.approve' | 'pr.merge' | 'status.publish' | 'reply.publish';
  readonly resourceId: ResourceId;
  readonly payload:
    | { readonly kind: 'pr.approve'; readonly revision: string; readonly body?: string }
    | {
        readonly kind: 'pr.merge';
        readonly revision: string;
        readonly method: 'merge' | 'squash' | 'rebase';
      }
    | { readonly kind: 'status.publish'; readonly body: string }
    | { readonly kind: 'reply.publish'; readonly body: string };
  readonly state: 'pending' | 'confirmed' | 'failed' | 'ambiguous';
  readonly attempts: number;
}

export interface ExternalDeliveryAdapter {
  deliver(intent: DeliveryIntentView, signal: AbortSignal): Promise<
    | { readonly kind: 'confirmed'; readonly externalId: string }
    | { readonly kind: 'failed'; readonly code: string; readonly message: string }
    | { readonly kind: 'ambiguous'; readonly reconciliationKey: string }
  >;
  reconcile(reconciliationKey: string, signal: AbortSignal): Promise<
    | { readonly kind: 'confirmed'; readonly externalId: string }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'unknown' }
  >;
}
```

Events:

```text
delivery.attempt-started
delivery.confirmed
delivery.failed
delivery.ambiguous
delivery.reconciled
```

`status.publish` and `reply.publish` preserve necessary provider delivery
behaviour. They are Integration intents, not general communication Activities.

- [ ] **Step 4: Implement the pure delivery projector**

`projectDeliveries(events)` recognizes configured canonical intent types by
event ID/global position and folds delivery-result events. It returns
unresolved views sorted by intent global position. Export it as the `delivery`
`ProjectionDefinition` and register it with the same ProjectionRunner used by
the other domains. It cannot append, call a clock, or invoke an adapter.

- [ ] **Step 5: Implement delivery and GitHub translation**

`DeliveryService.deliverNext`:

1. selects one unresolved intent;
2. resolves its Resource and adapter;
3. reconciles first if state is ambiguous;
4. appends attempt started;
5. calls adapter with intent event ID as idempotency key;
6. appends confirmed, failed, or ambiguous result;
7. returns after one external attempt.

GitHub outbound translation maps provider-neutral Resource/intent data into
Octokit calls. No `pr.merge` policy is re-evaluated in the adapter.

`DeliveryOutcomeReactor` consumes delivery facts using its own persisted
checkpoint:

```text
delivery.confirmed -> originating activation outcome done
delivery.failed -> originating activation outcome failed
delivery.ambiguous -> keep originating activation waiting
delivery.reconciled confirmed -> originating activation outcome done
```

It submits the outcome through Orchestration's public idempotent API and
advances its checkpoint only after acceptance.

For `pr.merge`, “confirmed” means the provider reports the pull request merged.
If a provider call only enables auto-merge, record delivery confirmation for
that request but keep the Activity waiting until inbound PR evidence records
`pr.state-changed` to `merged`. Do not equate “auto-merge enabled” with
“merged”.

- [ ] **Step 6: Add crash-window scenarios**

`E2E-DELIVERY-001` injects a crash after fake provider acceptance but before
`delivery.confirmed`; restart projects ambiguous/pending work, reconciliation
finds the existing effect, and no second merge call occurs.

`E2E-PR-MERGE-003` proves a permitted `pr.merge-requested` reaches GitHub once
and produces canonical confirmation. The parent WorkflowInstance remains
waiting before confirmation and progresses exactly once after confirmation.

- [ ] **Step 7: Pass Packet D gate**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/activities test-next/integrations test-next/e2e/scenarios/outbox-crash.test.ts test-next/e2e/scenarios/pr-merge-delivery.test.ts
npm run check:catalogue
npm run verify:next
npm run verify
```

Expected: delivery crash/reconciliation and complete PR safety suite PASS.

- [ ] **Step 8: Commit reliable delivery**

```powershell
git add src-next/integrations test-next/integrations test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: deliver target effects from the event journal"
```

## Task 22: Add leases, cancellation, timeout, and active-Run recovery

**Files:**

- Extend: `src-next/execution/contracts/{config,events,runner,views}.ts`
- Extend: `src-next/execution/domain/{run,run-result}.ts`
- Extend: `src-next/execution/application/execution-service.ts`
- Create: `src-next/execution/application/recovery-service.ts`
- Create: `test-next/execution/{cancellation,lease,recovery,timeout}.test.ts`
- Create: `test-next/e2e/scenarios/{cancel-active-run,recover-active-run}.test.ts`

- [ ] **Step 1: Write Run-liveness tests**

Cover:

```ts
it('records a renewable lease with owner and expiry');
it('does not let a second owner execute an unexpired Run');
it('records cancellation request before signalling the runner');
it('records cancellation confirmation separately');
it('turns timeout into a durable cancellation reason');
it('reconciles definitely completed execution without rerunning it');
it('reconciles definitely absent execution as failed');
it('records unknown external execution as ambiguous');
it('never automatically retries an ambiguous Run');
```

- [ ] **Step 2: Run and confirm recovery semantics are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution/recovery.test.ts
```

Expected: FAIL resolving `RecoveryService`.

- [ ] **Step 3: Extend the Run view**

Add:

```ts
readonly lease?: {
  readonly owner: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};
readonly externalExecution?: {
  readonly kind: 'process' | 'remote-session';
  readonly id: string;
  readonly startedAt: string;
};
readonly cancellation?: {
  readonly requestedAt: string;
  readonly reason:
    | 'operator'
    | 'work-cancelled'
    | 'workflow-superseded'
    | 'timeout'
    | 'shutdown';
  readonly confirmedAt?: string;
};
```

Lease duration and renewal interval are Execution-owned configuration.

- [ ] **Step 4: Implement cancellation and lease commands**

APIs:

```ts
claim(runId: string, owner: string): Promise<RunView>;
renewLease(runId: string, owner: string): Promise<RunView>;
requestCancellation(
  runId: string,
  reason: NonNullable<RunView['cancellation']>['reason'],
): Promise<RunView>;
confirmCancellation(runId: string): Promise<RunView>;
```

A handler reports external execution identity through
`ActivityExecutionContext`. An in-process AbortController is only a signalling
mechanism; durable events remain authoritative.

- [ ] **Step 5: Implement RecoveryService**

Define:

```ts
export interface ExternalExecutionInspector {
  inspect(reference: NonNullable<RunView['externalExecution']>): Promise<
    | { readonly kind: 'running' }
    | { readonly kind: 'completed'; readonly result: RunnerResult }
    | { readonly kind: 'absent' }
    | { readonly kind: 'unknown'; readonly reason: string }
  >;
}
```

`recover(run)` requires an expired lease and:

- renews/continues when definitely running;
- validates and records a recovered result when completed;
- records definite failure when absent before effect;
- records ambiguous when inspector cannot establish truth;
- never calls `ActivityHandler.execute` again.

- [ ] **Step 6: Add E2E scenarios**

`E2E-EXEC-CANCEL-001`: cancel Work while a fake runner is active; request and
confirmation survive restart; WorkflowInstance blocks/cancels according to its
policy.

`E2E-EXEC-RECOVER-001`: crash after external process completion but before Run
completion append; recovery records the existing result and produces no second
runner start.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/execution test-next/e2e/scenarios/cancel-active-run.test.ts test-next/e2e/scenarios/recover-active-run.test.ts
npm run verify:next
npm test -- test/core/stale-run-reconciler.test.ts test/core/tick-runner.reconcile.test.ts test/core/workspace-cleanup.test.ts
```

Expected: cancellation/recovery scenarios and selected legacy reliability
evidence PASS.

```powershell
git add src-next/execution test-next/execution test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: recover and cancel target Runs"
```

## Corrective gate before Task 23

Do not begin Task 23 until both corrections in
`docs/superpowers/plans/2026-07-31-wake-event-contract-corrections.md` pass all
required gates:

- [x] **Task 22A:** make activation claim/release events first-class typed
  Execution contracts tied to the activation stream.
- [x] **Task 21B:** replace Task 21's generic delivery payload/string handling,
  register delivery in production composition, and prove restart-safe delivery
  through composed E2E scenarios.

## Task 23: Compose tick, resident, scheduled, fairness, and quota policies

**Files:**

- Create: `src-next/control-plane/contracts/{commands,config}.ts`
- Create: `src-next/control-plane/domain/{dispatch-policy,schedule-policy}.ts`
- Create: `src-next/control-plane/application/{control-plane-service,schedule-service}.ts`
- Create: `src-next/control-plane/infrastructure/{resident-host,tick-host}.ts`
- Extend: `src-next/control-plane/index.ts`
- Create: `test-next/control-plane/{dispatch-policy,resident-host,schedule-service,tick-host}.test.ts`
- Create: `test-next/e2e/scenarios/{fairness,quota-pause,schedule-restart,tick-resident-equivalence}.test.ts`

- [x] **Step 1: Write host-independent policy tests**

Cover:

```ts
it('selects the oldest eligible activation without starving another WorkItem');
it('enforces one active Run per WorkItem');
it('enforces a global dispatch limit');
it('persists a quota pause and resumes only after the clock reaches it');
it('uses one stable identity for each elapsed schedule slot');
it('does not fire a schedule slot twice after restart');
it('does not create issue-shaped synthetic work');
```

- [x] **Step 2: Run and confirm host policies are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/control-plane/schedule-service.test.ts
```

Expected: FAIL resolving schedule/host services.

- [x] **Step 3: Define bounded host results**

```ts
export interface HostBudget {
  readonly maxAdvances: number;
  readonly maxRuns: number;
  readonly maxDurationMs: number;
}

export interface HostResult {
  readonly advances: number;
  readonly runs: number;
  readonly stoppedBecause:
    | 'idle'
    | 'waiting'
    | 'blocked'
    | 'budget'
    | 'paused'
    | 'shutdown';
}
```

`TickHost.run(budget)` exits after one bounded cycle. `ResidentHost.run(signal)`
repeats the same control-plane operation with fakeable backoff and never keeps
business state only in memory.

- [x] **Step 4: Implement durable scheduling**

Configuration:

```ts
export interface ScheduleConfig {
  readonly id: string;
  readonly workflow: string;
  readonly cron: string;
  readonly objective: string;
}
```

For each latest elapsed slot since durable checkpoint:

1. derive `schedule:<id>:<slot-iso>`;
2. create a normal WorkItem using that stable slot identity;
3. create a Resource of kind `schedule-slot`;
4. start the configured WorkflowInstance;
5. advance checkpoint only after all idempotent commands are accepted.

Schedule WorkItems contain no fake repository or issue number.

- [x] **Step 5: Implement fairness and quota facts**

DispatchPolicy orders pending activations by requested-event global position,
then activation ID. It excludes WorkItems with active Runs, cancelled Work, or
blocked global policy.

Quota classification appends:

```text
control-plane.dispatch-paused
control-plane.dispatch-resumed
```

The pause deadline is an event-derived view persisted under
`.wake/projections/control-plane`; export and register its pure
`ProjectionDefinition` when adding these events. No process-local timer is
authoritative.

- [x] **Step 6: Add E2E scenarios**

`E2E-SCHEDULE-001`: restart across an elapsed slot produces one WorkItem and
one workflow start.

`E2E-CONTROL-001`: two eligible WorkItems alternate according to ready
position; a watcher cannot monopolise the global budget.

`E2E-CONTROL-002`: the same initial journal and fake clock produce equivalent
domain events under repeated TickHost calls and one ResidentHost cycle.

`E2E-CONTROL-003`: quota pause survives restart and does not consume Run retry
budget.

- [x] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/control-plane test-next/e2e/scenarios/fairness.test.ts test-next/e2e/scenarios/quota-pause.test.ts test-next/e2e/scenarios/schedule-restart.test.ts test-next/e2e/scenarios/tick-resident-equivalence.test.ts
npm run verify:next
npm test -- test/core/scheduled-workflow-source.test.ts test/cli/control-plane.test.ts test/core/tick-runner.quota.test.ts
```

Expected: all host/policy scenarios and selected legacy evidence PASS.

```powershell
git add src-next/control-plane test-next/control-plane test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: compose target control-plane hosts"
```

## Task 24: Compose domain-owned configuration and bootstrap

**Files:**

- Create: `src-next/{work,resources,activities,orchestration,execution,control-plane,integrations,surfaces}/contracts/config.ts`
- Create: `src-next/bootstrap/config/{load-config,root-schema}.ts`
- Create: `src-next/bootstrap/{composition-root,paths}.ts`
- Modify: `src-next/bootstrap/index.ts`
- Create: `src-next/main.ts`
- Create: `test-next/bootstrap/{config-ownership,load-config,paths,runtime}.test.ts`
- Create: `test-next/e2e/scenarios/configured-workflow.test.ts`
- Create: `test-next/bootstrap/fixtures/config.yaml`
- Create: `test-next/bootstrap/fixtures/config.workflows.yaml`

- [ ] **Step 1: Write configuration-ownership tests**

Cover:

```ts
it('lets each module parse and default only its own subtree');
it('reports validation errors with domain-qualified paths');
it('validates activity.with through the selected Activity');
it('validates stage.execution through Execution');
it('validates stage.on through Orchestration');
it('does not pass WakeConfig to any module constructor');
it('resolves runtime data root to <wakeRoot>/.wake');
```

- [ ] **Step 2: Run and confirm bootstrap config is absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/bootstrap/config-ownership.test.ts
```

Expected: FAIL resolving target bootstrap.

- [ ] **Step 3: Define domain-shaped root configuration**

Use:

```yaml
schemaVersion: 1

work: {}

resources: {}

execution:
  runners:
    fake: { kind: fake }
  tiers:
    standard: [fake]
  defaultTier: standard

orchestration:
  workflows:
    default:
      stages:
        implement:
          activity: implement
          with:
            prompt: implement
          execution:
            workspace: branch
            tier: standard
          on:
            done:
              activities:
                - use: pr.approve
                - use: pr.merge
                  with:
                    target: primary
                    method: squash
                    requireChecks: true
              then: done
            blocked:
              then: await-human

controlPlane:
  schedules: []
  resident:
    idleBackoffMs: 1000

integrations:
  github:
    enabled: false
    repositories: []

surfaces:
  api: { enabled: false, port: 4317 }
```

Do not add communication/conversation or document Activities.

- [ ] **Step 4: Implement root composition without global config**

`loadConfig(wakeRoot)` loads/merges YAML, then calls each module schema.
`ResolvedWakeModulesConfig` is a bootstrap-local aggregate. CompositionRoot
passes only:

```text
workConfig -> Work
resourceConfig -> Resources
activityConfig -> Activity registration
orchestrationConfig -> compiler/service
executionConfig -> Execution
controlPlaneConfig -> hosts/policies
integrationConfig -> Integrations
surfaceConfig -> Surfaces
```

No exported domain/application signature accepts the aggregate.

- [ ] **Step 5: Wire filesystem persistence**

`resolveWakePaths(wakeRoot)` returns:

```ts
{
  wakeRoot,
  dataRoot: join(wakeRoot, '.wake'),
  eventsRoot: join(wakeRoot, '.wake', 'events'),
  projectionsRoot: join(wakeRoot, '.wake', 'projections'),
  checkpointsRoot: join(wakeRoot, '.wake', 'checkpoints'),
  locksRoot: join(wakeRoot, '.wake', 'locks'),
  transcriptsRoot: join(wakeRoot, '.wake', 'transcripts'),
  workspacesRoot: join(wakeRoot, 'workspaces'),
}
```

CompositionRoot constructs FileEventJournal, FileProjectionStore, and
FileCheckpointStore and injects only their Kernel port types. It registers all
domain projectors and does not import domain internals.

- [ ] **Step 6: Add configured-workflow scenario**

`E2E-CONFIG-001` loads the example config from a temporary Wake root, executes
one fake `implement` stage, and proves each module receives only its subtree.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/bootstrap test-next/e2e/scenarios/configured-workflow.test.ts
npm run verify:next
npm test -- test/config test/domain/config-schema-split.test.ts
```

Expected: target config/bootstrap and selected legacy configuration evidence
PASS.

```powershell
git add src-next/bootstrap src-next/main.ts src-next/*/contracts/config.ts test-next/bootstrap test-next/e2e docs/architecture/functional-decision-catalogue.md
git commit -m "feat: compose target runtime from domain config"
```

## Task 25: Rebuild CLI, API, and UI over public application views

> **Approved web architecture:** Implement
> [`2026-07-30-wake-web-surface-architecture-design.md`](../specs/2026-07-30-wake-web-surface-architecture-design.md).
> The operator approved that companion design on 2026-07-30. Task 24 remains a
> prerequisite because Task 25 consumes its public applications,
> configuration, and bootstrap composition; do not start Task 25 production
> code before the Task 24 gate passes.

The approved decision is:

- a private React and TypeScript npm workspace built by Vite;
- React Router browser-history routes and TanStack Query server state;
- no component, table, CSS, graph, icon, general state, or HTTP server
  framework initially;
- API source and clients grouped by Wake domain/capability, while browser code
  is grouped by operator feature;
- clean shareable paths, never hash routing;
- one UI-agnostic `/api/v1`, using WorkItem keys, success envelopes, cursor
  pagination, UTC timestamps, and RFC 9457 Problem Details;
- no authentication in v1; the HTTP surface remains locally scoped;
- independently refreshing JSON-bound components, with polling and immediate
  mutation reconciliation rather than full-document replacement;
- compiled assets served through a replaceable Surface adapter and shipped
  inside Wake; `wake init` writes no UI artifacts;
- Chromium Playwright coverage at desktop and mobile viewports;
- no separately embeddable component package until a second consumer exists.

**Files:**

- Create: `src-next/surfaces/cli/{main,usage}.ts`
- Create: `src-next/surfaces/cli/commands/{api,audit,correlate,start,stop,tick,ui,validate-state}.ts`
- Create: `src-next/surfaces/api/contracts/{common,control-plane,work,resources,orchestration,execution,activities,events,observability,system,index}.ts`
- Create: `src-next/surfaces/api/presenters/{control-plane,work,resources,orchestration,execution,activities,events,observability,system}.ts`
- Create: `src-next/surfaces/api/routes/{control-plane,work,resources,orchestration,execution,activities,events,observability,system}.ts`
- Create: `src-next/surfaces/api/{http-server,problem-details,router}.ts`
- Create: `src-next/surfaces/web-host/{asset-source,packaged-assets}.ts`
- Create: `src-next/surfaces/web/package.json`
- Create: `src-next/surfaces/web/tsconfig.json`
- Create: `src-next/surfaces/web/{vite.config,vitest.config,playwright.config}.ts`
- Create: `src-next/surfaces/web/index.html`
- Create: `src-next/surfaces/web/src/{main.tsx,app/**,api/**,components/**,features/**,styles/**}`
- Create: `src-next/surfaces/web/{test,e2e}/**`
- Modify: `src-next/surfaces/index.ts`
- Modify: `src-next/surfaces/contracts/config.ts`
- Modify: `src-next/bootstrap/composition-root.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.next.json`
- Modify: `vitest.next.config.ts`
- Modify: `dependency-cruiser.config.mjs`
- Modify: `knip.next.json`
- Modify: `docker/Dockerfile`
- Modify: `docker/Dockerfile.packaged`
- Create: `test-next/surfaces/{api,cli-main,cli-runtime-commands,web-assets,web-server}.test.ts`
- Create: `test-next/e2e/scenarios/api-domain-shape.test.ts`

- [x] **Step 0: Approve and incorporate the web-architecture amendment**

The companion design and this amended task satisfy the web-architecture
decision gate. Reconfirm only if implementation discovers a need for a
dependency or boundary that the companion design explicitly excludes.

- [ ] **Step 1: Write surface-boundary tests**

Cover:

```ts
it('routes CLI commands without importing a store or provider client');
it('audit reads canonical events and causal links');
it('validate-state reports journal, projection, and checkpoint health');
it('API composition nests work, resources, orchestration, execution, and activities');
it('API routes and the typed web client group operations by domain capability');
it('the typed web API client uses transport contracts and public views only');
it('surface actions call application commands rather than writing state');
it('the web build is isolated from domain and adapter implementation imports');
it('clean browser-history paths do not intercept API or asset 404s');
it('packaged assets are served without writing UI artifacts into a Wake home');
it('WorkItem links use WorkItemKey rather than a resource locator');
it('API errors use RFC 9457 Problem Details');
it('API timestamps are UTC and browser timestamps are localized');
```

Under `src-next/surfaces/web/test`, add behavior tests for:

- first load, cached refresh, empty, stale, error, reconnecting, and delayed
  mutation states;
- board and WorkItem clean-route navigation;
- desktop route-backed WorkItem detail and mobile full-page detail;
- independent status, board, WorkItem, Run, event/audit, health, and runner
  availability updates;
- events/audit pause, buffered count, and resume without viewport movement;
- semantic tables, keyboard focus, and accessible status.

- [ ] **Step 2: Run and confirm surfaces are absent**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/surfaces/cli-main.test.ts
npm run test:web
```

Expected: FAIL resolving target surfaces and the unimplemented web
application.

- [ ] **Step 3: Define domain-shaped API contracts**

```ts
export interface WorkDetailResponse {
  readonly work: WorkItemView;
  readonly resources: readonly ResourceView[];
  readonly orchestration: {
    readonly primary: WorkflowInstanceView | null;
    readonly children: readonly WorkflowInstanceView[];
  };
  readonly execution: { readonly runs: readonly RunView[] };
  readonly activities: {
    readonly pullRequest?: PullRequestView;
  };
}
```

Do not flatten stage, Run, issue, and PR fields into one object. Provider raw
payload is not exposed by the v1 API.

The API is grouped by domain/capability, not UI feature. Do not add `/board`,
`/status-bar`, `/drawer`, or other screen-shaped routes. Initial read groups
cover control-plane status, WorkItems, Resources, WorkflowInstances, Runs,
transcripts, runners, events, observability metrics, health, and redacted
configuration.

Use:

```ts
interface ResourceResponse<T> {
  readonly data: T;
  readonly meta: { readonly asOf: string; readonly position?: number };
}

interface CollectionResponse<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly total?: number;
  };
  readonly meta: { readonly asOf: string; readonly position?: number };
}
```

Collection cursors are opaque. API timestamps are UTC RFC 3339 values with a
`Z` suffix. Errors use `application/problem+json`; stable extensions may
include `code`, `retryable`, `current`, and `violations`.

- [ ] **Step 4: Rebuild runtime CLI commands**

Commands:

```text
wake tick
wake start
wake stop
wake api
wake ui
wake audit <work-item-id>
wake correlate <resource> <work-item-id>
wake validate-state
```

Each command receives an application facade from bootstrap. `tick` invokes
TickHost, `start` invokes ResidentHost, `audit` formats journal facts,
`correlate` calls ResourceService, and `validate-state --rebuild-projections`
calls an injected `ProjectionMaintenance` surface port after explicit operator
selection. Bootstrap implements that port with ProjectionRunner; Surfaces do
not import Persistence.

`wake api` starts the API alone. `wake ui` starts the API plus packaged web
assets. `wake start` starts the processor and optionally enabled API/web hosts
in the same Node.js process from:

```yaml
surfaces:
  api:
    enabled: false
    host: 127.0.0.1
    port: 4317
  web:
    enabled: false
```

`web.enabled` requires `api.enabled`. There is no auth configuration in v1.
Bind loopback by default; Docker may publish an internal bind only to host
loopback.

- [ ] **Step 5: Port HTTP mechanics and implement the approved web application**

Port accepted routing, compiled-asset serving, and error-mapping behavior from:

```text
test/adapters/ui-server.test.ts
test/adapters/ui-data.test.ts
```

Do not port legacy token gating: v1 is unauthenticated and locally scoped. Do
not create `ui/data.ts`. Domain presenters, transport contracts, and the typed
client replace that legacy-shaped boundary.

Add one private npm workspace at `src-next/surfaces/web` with these runtime
dependencies:

```text
react
react-dom
react-router
@tanstack/react-query
```

Add these development dependencies:

```text
vite
@vitejs/plugin-react
typescript
vitest
jsdom
@testing-library/react
@testing-library/user-event
@playwright/test
@axe-core/playwright
```

Browser source is organized by operator feature:

```text
src/
  app/
  api/
  components/
  features/{board,work,events,runs,observability,health,configuration}/
  styles/
```

Use React Router browser-history paths `/board`, `/work`,
`/work/:workItemKey`, `/events`, `/runs`, `/runs/:runId`,
`/observability`, `/health`, and `/configuration`. WorkItem detail is a
route-backed modal from desktop list/board navigation and a full page for
direct loads and mobile. Never use hash routes.

Use CSS Modules, global design tokens, native semantic elements, and a small
Wake-owned shared component layer. Do not add a component library, table
library, CSS framework, icon suite, or general state library. The initial
JavaScript entry budget is 150 KiB gzip.

Use TanStack Query for JSON binding:

- status polls every 2 seconds;
- board, open WorkItem, active Runs, and incremental events/audit poll every 3
  seconds;
- historical Runs poll every 5 seconds while visible;
- health and runner availability poll every 5 seconds;
- observability analytics and configuration refresh only explicitly;
- background tabs reduce or stop polling and revalidate on focus;
- confirmed mutations update the narrow cache immediately and invalidate
  related queries for authoritative reconciliation;
- `Pause live view` and scrolled-away event feeds buffer records and show a
  `new events` count without moving the viewport.

React mounts once; no update replaces the whole document. A future SSE
transport may emit domain/resource invalidation signals only and must reuse
the same resource queries.

Vite writes target-lane assets to
`dist-next/src-next/surfaces/web-assets/`. After cutover the equivalent path is
`dist/src/surfaces/web-assets/`. Serve `index.html` with revalidation and
content-hashed assets as immutable. SPA fallback applies only to extensionless
non-API application `GET`/`HEAD` paths. Verify npm and both Docker builds
contain the assets and `wake init` contains none.

- [ ] **Step 6: Add `E2E-SURFACE-001`**

Create work, resource, workflow, and Run through public commands; query the API
and assert the nested domain shape and absence of raw GitHub payload.

Run Playwright against the real HTTP Surface with deterministic application
boundaries. Cover Chromium desktop and mobile journeys for shell/board load,
clean-route deep links, WorkItem detail presentation, one mutation and
reconciliation, Problem Details conflict, event pause/buffer/resume, health
refresh, keyboard navigation, and serious automated accessibility violations.
Do not create a standalone mock server.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npm run build:web
npm run test:web
npm run test:web:e2e
npx vitest run --config vitest.next.config.ts test-next/surfaces test-next/e2e/scenarios/api-domain-shape.test.ts
npm run verify:next
npm test -- test/cli/main.test.ts test/cli/audit-command.test.ts test/adapters/ui-server.test.ts test/adapters/ui-data.test.ts
```

Expected: target surfaces and selected legacy surface evidence PASS.

The Packet E gate cannot pass using a temporary embedded UI, a mock API
product, hash routing, or with any web verification omitted.

```powershell
git add package.json package-lock.json tsconfig.next.json vitest.next.config.ts dependency-cruiser.config.mjs knip.next.json
git add src-next/surfaces src-next/bootstrap docker test-next/surfaces test-next/e2e
git add docs/architecture/functional-decision-catalogue.md
git commit -m "feat: expose target domain surfaces"
```

## Task 26: Port operational commands without leaking them into the domain

**Files:**

- Create: `src-next/surfaces/cli/commands/{doctor,init,sandbox,self-update,smoke}.ts`
- Create: `src-next/surfaces/cli/infrastructure/{docker-cli,process-log}.ts`
- Extend: `src-next/bootstrap/paths.ts`
- Create: `test-next/surfaces/{doctor,init,sandbox,self-update,smoke}.test.ts`
- Create: `test-next/e2e/scenarios/doctor-rebuild.test.ts`
- Modify: `scripts/e2e-github-fake.ts`

- [ ] **Step 1: Classify operational evidence in the catalogue**

For every test under these prefixes, mark preserve/correct/consolidate/remove
before porting:

```text
test/cli/doctor-command.test.ts
test/cli/init-command.test.ts
test/cli/sandbox-*.test.ts
test/cli/scaffold-assets.test.ts
test/cli/self-update-command.test.ts
test/cli/startup-preflight.test.ts
test/cli/stop-command.test.ts
test/adapters/docker-cli.test.ts
test/lib/detached-process-logging.test.ts
```

Operational convenience does not justify imports into Work, Orchestration,
Activities, or Execution domain code.

- [ ] **Step 2: Port accepted tests and run them failing**

Create focused target test files under 400 lines and update imports. Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/surfaces/doctor.test.ts
```

Expected: FAIL resolving target operational commands.

- [ ] **Step 3: Implement `init` and `doctor` around the target layout**

`init` creates visible config/prompt assets and these runtime directories:

```text
.wake/events
.wake/projections
.wake/checkpoints
.wake/locks
.wake/transcripts
workspaces
```

`doctor` validates configuration, runtime versions, filesystem permissions,
journal integrity, projection/checkpoint health, runner/provider availability,
and optional Docker/sandbox health. It never repairs canonical events. An
explicit `--rebuild-projections` uses the injected ProjectionMaintenance port
to clear and replay derived views.

- [ ] **Step 4: Port sandbox, self-update, and smoke mechanics**

Keep process invocation, logging, secret scrubbing, container detection,
version drift, update-loop, and runner smoke behaviours whose catalogue
disposition is `preserve` or `correct`. Put Docker/process helpers under the
Surface infrastructure folder and pass them as command dependencies.

The self-update mechanism may replace application files but cannot rewrite
journal events or projection truth. Smoke uses target Runner contracts.

- [ ] **Step 5: Retarget the fake GitHub E2E script**

`scripts/e2e-github-fake.ts` constructs target bootstrap with fake integration
and runner boundaries. It writes all runtime state under a temporary
`<wakeRoot>/.wake` and asserts no legacy state file is created.

- [ ] **Step 6: Add `E2E-OPS-001`**

Corrupt a disposable projection file while leaving events valid. `doctor`
reports the path/namespace, rebuild restores the public view, and journal bytes
remain unchanged.

- [ ] **Step 7: Pass Packet E gate**

Run:

```powershell
npx vitest run --config vitest.next.config.ts test-next/surfaces test-next/bootstrap test-next/e2e/scenarios/doctor-rebuild.test.ts
npm run check:catalogue
npm run verify:next
npm run verify
```

Expected: target product/operations surfaces and the complete legacy suite
PASS.

- [ ] **Step 8: Commit operational surfaces**

```powershell
git add src-next/surfaces src-next/bootstrap test-next/surfaces test-next/e2e scripts/e2e-github-fake.ts docs/architecture/functional-decision-catalogue.md
git commit -m "feat: port target operational commands"
```

## Task 27: Prove functional-decision and scenario coverage

**Files:**

- Create: `scripts/check-scenario-coverage.mjs`
- Create: `docs/architecture/rewrite-completion-audit.md`
- Create: `test-next/e2e/scenarios/{duplicates,fault-matrix,security-boundaries}.test.ts`
- Modify: `package.json`
- Modify: `docs/architecture/functional-decision-catalogue.md`

- [ ] **Step 1: Add the scenario-coverage checker**

Implement a script that:

1. extracts every `E2E-[A-Z0-9-]+` ID from catalogue scenario cells;
2. extracts every `id: 'E2E-...'` or `id: "E2E-..."` from
   `test-next/e2e/**/*.test.ts`;
3. rejects missing catalogue scenarios;
4. rejects duplicate scenario definitions;
5. rejects target scenarios not referenced by a catalogue row unless their ID
   starts with `E2E-HARNESS-` or `E2E-GOLDEN-`.

Add:

```json
"check:scenarios": "node scripts/check-scenario-coverage.mjs"
```

Include it in `verify:next` after `check:catalogue`.

- [ ] **Step 2: Run coverage and close every reported gap**

Run:

```powershell
npm run check:catalogue
npm run check:scenarios
```

Expected: both PASS. For each failure, either add the named target scenario or
change the catalogue disposition with an explicit reason. Never delete
evidence paths to make the check pass.

- [ ] **Step 3: Complete cross-cutting fault scenarios**

`E2E-FAULT-001` injects a failure immediately before and after each of:

```text
journal append
projection write
checkpoint write
Run start
Run result append
workflow outcome acceptance
outbound provider acceptance
delivery confirmation append
child completion consumption
schedule slot checkpoint
```

For each point assert either safe replay, explicit ambiguity, or human
escalation; never duplicate an unsafe effect.

`E2E-DUPLICATE-001` duplicates inbound provider event, signal command, Run
outcome, child completion, and delivery confirmation; public state/effects are
unchanged after the first accepted fact.

`E2E-SECURITY-001` covers prompt text containing commands, untrusted bot actor,
wrong Resource correlation, stale revision, and agent-reported merge request.
None bypass domain validation.

- [ ] **Step 4: Run accepted differential checks**

For catalogue rows marked `preserve`, drive legacy and target fakes with the
same high-level input where practical and compare only:

```text
public lifecycle outcome
number/kind of external effects
selected Activity
workspace mode
operator-visible reply/status
```

Do not compare internal events, file paths, projections, or legacy status
objects. Record rows that cannot be compared and point to their target scenario
instead.

- [ ] **Step 5: Write the completion audit**

`docs/architecture/rewrite-completion-audit.md` contains one section per
design section 1-20 and records:

```text
requirement
implementing files
proving tests/scenarios
verification command
result
```

Every deferred design capability cites its catalogue decision. No row may say
“covered by tests” without naming the tests.

- [ ] **Step 6: Run maintainability and full pre-cutover verification**

Run:

```powershell
npm run check:catalogue
npm run check:scenarios
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```

Expected: all PASS. Review every Knip ignore; each must name the runtime loading
mechanism that requires it.

- [ ] **Step 7: Commit the audit**

```powershell
git add scripts/check-scenario-coverage.mjs docs/architecture package.json test-next/e2e
git commit -m "test: prove target rewrite coverage"
```

## Task 28: Cut over atomically and remove the legacy implementation

**Files:**

- Delete: `src/**`
- Delete: `test/**`
- Rename: `src-next/` to `src/`
- Rename: `test-next/` to `test/`
- Rename: `tsconfig.next.json` to `tsconfig.json`
- Rename: `vitest.next.config.ts` to `vitest.config.ts`
- Modify: `package.json`
- Modify: `dependency-cruiser.config.mjs`
- Modify: `knip.next.json`

- [ ] **Step 1: Verify exact destructive targets**

Run:

```powershell
Resolve-Path -LiteralPath src
Resolve-Path -LiteralPath test
Resolve-Path -LiteralPath src-next
Resolve-Path -LiteralPath test-next
git status --short
```

Expected: all four paths resolve inside the repository and the worktree is
clean. Stop if either target directory is absent or resolves outside the
repository.

- [ ] **Step 2: Run the last side-by-side gate**

Run:

```powershell
npm run verify
npm run verify:next
npm run check:catalogue
npm run check:scenarios
```

Expected: all PASS.

- [ ] **Step 3: Remove legacy and rename target directories**

Run only after Steps 1-2 pass:

```powershell
git rm -r -- src test
git mv src-next src
git mv test-next test
git rm -- tsconfig.json vitest.config.ts
git mv tsconfig.next.json tsconfig.json
git mv vitest.next.config.ts vitest.config.ts
```

This deletion is intentional and recoverable from Git history. Do not retain a
`legacy`, `compat`, or bridge directory.

- [ ] **Step 4: Apply mechanical path/script changes**

Update target test imports from `src-next` to `src`. Change:

```text
build:next -> build
test:next -> test
verify:next -> verify
knip:next -> knip
```

Remove legacy script definitions rather than keeping aliases. Update
dependency-cruiser roots from `src-next/` to `src/` and remove
`no-legacy-imports` because no legacy source remains. Rename `knip.next.json`
to `knip.json` and update paths.

The final verification-related scripts are:

```json
{
  "build": "tsc -p tsconfig.json && node scripts/embed-version.mjs",
  "test": "vitest run",
  "lint:architecture": "node scripts/check-module-manifests.mjs && depcruise --config dependency-cruiser.config.mjs src",
  "check:catalogue": "node scripts/check-functional-catalogue.mjs",
  "check:scenarios": "node scripts/check-scenario-coverage.mjs",
  "knip": "knip --config knip.json",
  "verify": "npm run check:catalogue && npm run check:scenarios && npm run lint:architecture && npm run lint && npm run format:check && npm run build && npm test"
}
```

Replace the renamed self-referencing `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 5: Build the packaged entrypoint**

Ensure:

```json
"bin": { "wake": "dist/src/main.js" },
"main": "./dist/src/main.js",
"exports": "./dist/src/main.js"
```

`src/main.ts` delegates to target bootstrap/surfaces only.

- [ ] **Step 6: Run post-cutover verification before committing**

Run:

```powershell
npm run format
npm run verify
npm run check:catalogue
npm run check:scenarios
npm run knip
rg -n 'src-next|test-next|src/core/tick-runner|IssueStateRecord|WakeConfig' src test package.json tsconfig.json vitest.config.ts
```

Expected: verification and Knip PASS; `rg` returns no architectural legacy
references. Historical evidence paths may remain only in the catalogue and
design/history documents.

- [ ] **Step 7: Commit the atomic cutover**

```powershell
git add -A
git commit -m "refactor: replace Wake with target architecture"
```

## Task 29: Update authoritative documentation and run the final audit

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/events.md`
- Modify: `docs/execution-invariants.md`
- Modify: `docs/workflows.md`
- Modify: `docs/configuration.md`
- Modify: `docs/cli.md`
- Modify: `docs/development.md`
- Modify: `README.md`
- Modify: `docs/architecture/rewrite-completion-audit.md`

- [ ] **Step 1: Rewrite operator and contributor docs from target contracts**

Document:

- eleven module responsibilities and dependency direction;
- `.wake/events`, `.wake/projections`, `.wake/checkpoints`, locks and
  transcripts, plus the visible `workspaces/` execution scratch directory;
- events as truth and projection deletion/rebuild;
- WorkItem, Resource, WorkflowInstance, ActivityActivation, Run, and PR
  vocabulary;
- `activity` / `with` / `execution` / `on` configuration ownership;
- tick, resident, and schedule equivalence;
- CLI/API domain-shaped surfaces;
- architecture checks and `MODULE.md` workflow.

Do not describe communication/conversation or document Activities as
implemented.

- [ ] **Step 2: Check documentation against public contracts**

Run:

```powershell
rg -n 'action:|onDone:|IssueStateRecord|StateStore|tick-runner|github.*core|document\\.generate|conversation\\.summarize' README.md docs src
```

Expected: matches exist only in explicitly historical design/evidence
documents. Current operator/contributor docs use target vocabulary.

- [ ] **Step 3: Re-run every proof command from the completion audit**

Run:

```powershell
npm run check:catalogue
npm run check:scenarios
npm run lint:architecture
npm run lint
npm run format:check
npm run build
npm test
npm run knip
npm pack --dry-run
git status --short
```

Expected: every command PASS; package dry run contains target runtime files;
only intended documentation changes are uncommitted before the final commit.

- [ ] **Step 4: Complete the requirement-by-requirement audit**

For every design success criterion, record the exact current file, test, and
command output proving it. Mark completion only when evidence is direct. If any
proof is missing, return to its owning task rather than adding an audit
exception.

- [ ] **Step 5: Commit the final documentation**

```powershell
git add README.md docs
git commit -m "docs: describe target Wake architecture"
```

- [ ] **Step 6: Confirm final repository state**

Run:

```powershell
git status --short
git log -10 --oneline
npm run verify
```

Expected: clean worktree, ordered rewrite commits, and final verification PASS.

## Final completion gate

The rewrite is complete only when all of the following are simultaneously
true:

- every frozen legacy evidence path has an explicit functional decision;
- every preserved/corrected/consolidated decision names a passing target
  scenario;
- no target code imports or retains legacy domain/orchestration models;
- all canonical events, persisted projections, and checkpoints live beneath
  `<wakeRoot>/.wake` through Persistence ports;
- projection deletion and replay restore equivalent public views;
- workflow, execution, control-plane, integration, and specialist PR policies
  have their agreed owners;
- tick, resident, and scheduled hosts use the same bounded progression
  capability;
- revision-bound approval, merge, external-effect ambiguity, child-loop,
  cancellation, and recovery scenarios pass;
- CLI/API/UI expose public domain views rather than storage objects;
- dependency, complexity, scenario, catalogue, dead-code, build, test, and
  package verification all pass;
- the legacy implementation and transition-only code are absent.
