# Git-Style .wake/ Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `paths.ts` into a visible project root and a hidden `.wake/` data root; make `--wake-root` default consistently to `cwd` for every command; fold sandbox routing (today: generated `wake.sh`/`wake.ps1`) into `dispatchMainCommand` with a `--host` escape hatch, triggered by `docker/Dockerfile` presence; fold `setup.sh`, `log-command.sh`, and `entrypoint.sh` into TypeScript CLI subcommands so `wake-home/docker/` scaffolds only `Dockerfile`.

**Architecture:** `paths.ts` computes an internal `dataRoot = join(wakeRoot, '.wake')` and re-bases every non-user-facing path onto it — this is the only file whose path *values* change; every adapter/command already imports from it, so no other file needs path-string edits. `main.ts` gains a `--host` flag check and a `hasDockerfile(wakeRoot)` probe that together decide whether a runtime command execs into `sandbox exec` or runs on the host as today. The three shell scripts become: `wake sandbox setup` (a new subcommand doing the same auth-bootstrap prompts via Node `readline`), a scrub/mirror transform inlined into the `exec` subcommand's process-spawn path (replacing the mounted `log-command.sh` wrapper), and `wake sandbox-entrypoint` (a new subcommand replacing `ENTRYPOINT ["/app/docker/entrypoint.sh"]`).

**Tech Stack:** TypeScript, Vitest, Node `node:child_process`, `node:readline/promises`.

## Global Constraints

- This is a breaking layout change by design (spec finding #15) — no migration script, no backwards-compatibility shim for the old flat layout. Existing wake-homes get restructured by hand; document the manual steps, don't build tooling for it.
- `workspaces/` and `config.json` stay at the visible `wakeRoot` level; every other runtime path (`repos/`, `logs/`, `container-home/`, `events/`, `events-by-id/`, `state/`, `runs/`, `sources/`, `locks/`, `control/`, `ledger.json`, `PAUSE`, `transcripts/`) moves under `.wake/`.
- `docker/Dockerfile` must only ever be written by `wake sandbox build` (landed in the dev-mode-packaged-builds plan) — this plan must not reintroduce Dockerfile scaffolding in `wake init`.
- `dispatchMainCommand`'s auto-delegation must trigger only when `docker/Dockerfile` exists at the resolved wake-root, and must never trigger for `init`/`sandbox`/`stop`.
- Run `npm run verify` before considering the branch done (per `CLAUDE.md`).

---

### Task 1: `paths.ts` splits project root from data root

**Files:**

- Modify: `src/lib/paths.ts`
- Test: find the existing test file (`find test -iname "paths*"`) and extend it — if none exists, create `test/lib/paths.test.ts`

**Interfaces:**

- Produces: `createWakePaths(wakeRoot)`'s return type is unchanged (same key names), only path *values* change for the keys listed below.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createWakePaths } from '../../src/lib/paths.js';

describe('createWakePaths', () => {
  const wakeRoot = '/tmp/wake-home';
  const paths = createWakePaths(wakeRoot);

  it('keeps user-facing paths at the visible wakeRoot', () => {
    expect(paths.configFile).toBe(join(wakeRoot, 'config.json'));
    expect(paths.workspaceRoot).toBe(join(wakeRoot, 'workspaces'));
    expect(paths.workspaceDir('work-1')).toBe(join(wakeRoot, 'workspaces', 'work-1'));
  });

  it('moves internal/durable paths under .wake/', () => {
    const dataRoot = join(wakeRoot, '.wake');
    expect(paths.containerHomeRoot).toBe(join(dataRoot, 'container-home'));
    expect(paths.ledgerFile).toBe(join(dataRoot, 'ledger.json'));
    expect(paths.pauseFile).toBe(join(dataRoot, 'PAUSE'));
    expect(paths.tickRequestFile).toBe(join(dataRoot, 'control', 'tick-request.json'));
    expect(paths.tickLockFile).toBe(join(dataRoot, 'locks', 'tick.lock'));
    expect(paths.runnerLockFile).toBe(join(dataRoot, 'locks', 'runner.lock'));
    expect(paths.issueFixtureFile).toBe(join(dataRoot, 'fixtures', 'issues.json'));
    expect(paths.transcriptsRoot).toBe(join(dataRoot, 'transcripts'));
    expect(paths.transcriptWorkDir('work-1')).toBe(join(dataRoot, 'transcripts', 'work-1'));
    expect(paths.reposRoot).toBe(join(dataRoot, 'repos'));
    expect(paths.repoRoot('org/repo')).toBe(join(dataRoot, 'repos', 'org__repo'));
    expect(paths.sourceStateRoot).toBe(join(dataRoot, 'sources'));
    expect(paths.workItemStateFile('work-1')).toBe(join(dataRoot, 'state', 'work-1.json'));
    expect(paths.archivedWorkItemStateFile('work-1')).toBe(
      join(dataRoot, 'state', 'archive', 'work-1.json'),
    );
    expect(paths.runFile('run-1')).toBe(join(dataRoot, 'runs', 'run-1.json'));
    expect(paths.eventFile('2026-07-22')).toBe(join(dataRoot, 'events', '2026-07-22.jsonl'));
    expect(paths.eventEnvelopeFile('evt-1')).toBe(join(dataRoot, 'events-by-id', 'evt-1.json'));
    expect(paths.logFile('2026-07-22')).toBe(join(dataRoot, 'logs', '2026-07-22.log'));
    expect(paths.resourceIndexRoot).toBe(join(dataRoot, 'state', 'index'));
    expect(paths.resourceIndexShardFile('a1')).toBe(join(dataRoot, 'state', 'index', 'a1.json'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/paths.test.ts` (adjust path if an existing file was found instead)
Expected: FAIL — every `.wake/`-prefixed assertion currently resolves directly under `wakeRoot` with no `.wake` segment.

- [ ] **Step 3: Implement the split**

In `src/lib/paths.ts`, change:

```typescript
export function createWakePaths(wakeRoot: string) {
  return {
    wakeRoot,
    containerHomeRoot: join(wakeRoot, 'container-home'),
    configFile: join(wakeRoot, 'config.json'),
    ledgerFile: join(wakeRoot, 'ledger.json'),
    pauseFile: join(wakeRoot, 'PAUSE'),
    tickRequestFile: join(wakeRoot, 'control', 'tick-request.json'),
    tickLockFile: join(wakeRoot, 'locks', 'tick.lock'),
    runnerLockFile: join(wakeRoot, 'locks', 'runner.lock'),
    issueFixtureFile: join(wakeRoot, 'fixtures', 'issues.json'),
    workspaceRoot: join(wakeRoot, 'workspaces'),
    transcriptsRoot: join(wakeRoot, 'transcripts'),
    reposRoot: join(wakeRoot, 'repos'),
    repoRoot: (repo: string) => join(wakeRoot, 'repos', sanitizeRepo(repo)),
    sourceStateRoot: join(wakeRoot, 'sources'),
    workItemStateFile: (workId: string) => join(wakeRoot, 'state', `${workId}.json`),
    archivedWorkItemStateFile: (workId: string) =>
      join(wakeRoot, 'state', 'archive', `${workId}.json`),
    sourceStateFile: (source: string, key: string) =>
      join(wakeRoot, 'sources', sanitizePathKey(source), `${sanitizePathKey(key)}.json`),
    runFile: (runId: string) => join(wakeRoot, 'runs', `${runId}.json`),
    runDateFile: (date: string, runId: string) =>
      join(wakeRoot, 'runs', 'by-date', date, `${runId}.json`),
    eventFile: (date: string) => join(wakeRoot, 'events', `${date}.jsonl`),
    eventEnvelopeFile: (eventId: string) =>
      join(wakeRoot, 'events-by-id', `${sanitizePathKey(eventId)}.json`),
    logFile: (date: string) => join(wakeRoot, 'logs', `${date}.log`),
    workspaceDir: (workId: string) => join(wakeRoot, 'workspaces', workId),
    transcriptWorkDir: (workId: string) => join(wakeRoot, 'transcripts', workId),
    transcriptSessionDir: (workId: string, sessionKey: string) =>
      join(wakeRoot, 'transcripts', workId, sanitizePathKey(sessionKey)),
    resourceIndexRoot: join(wakeRoot, 'state', 'index'),
    resourceIndexShardFile: (shard: string) => join(wakeRoot, 'state', 'index', `${shard}.json`),
  };
}
```

to:

```typescript
export function createWakePaths(wakeRoot: string) {
  const dataRoot = join(wakeRoot, '.wake');

  return {
    wakeRoot,
    dataRoot,
    containerHomeRoot: join(dataRoot, 'container-home'),
    configFile: join(wakeRoot, 'config.json'),
    ledgerFile: join(dataRoot, 'ledger.json'),
    pauseFile: join(dataRoot, 'PAUSE'),
    tickRequestFile: join(dataRoot, 'control', 'tick-request.json'),
    tickLockFile: join(dataRoot, 'locks', 'tick.lock'),
    runnerLockFile: join(dataRoot, 'locks', 'runner.lock'),
    issueFixtureFile: join(dataRoot, 'fixtures', 'issues.json'),
    workspaceRoot: join(wakeRoot, 'workspaces'),
    transcriptsRoot: join(dataRoot, 'transcripts'),
    reposRoot: join(dataRoot, 'repos'),
    repoRoot: (repo: string) => join(dataRoot, 'repos', sanitizeRepo(repo)),
    sourceStateRoot: join(dataRoot, 'sources'),
    workItemStateFile: (workId: string) => join(dataRoot, 'state', `${workId}.json`),
    archivedWorkItemStateFile: (workId: string) =>
      join(dataRoot, 'state', 'archive', `${workId}.json`),
    sourceStateFile: (source: string, key: string) =>
      join(dataRoot, 'sources', sanitizePathKey(source), `${sanitizePathKey(key)}.json`),
    runFile: (runId: string) => join(dataRoot, 'runs', `${runId}.json`),
    runDateFile: (date: string, runId: string) =>
      join(dataRoot, 'runs', 'by-date', date, `${runId}.json`),
    eventFile: (date: string) => join(dataRoot, 'events', `${date}.jsonl`),
    eventEnvelopeFile: (eventId: string) =>
      join(dataRoot, 'events-by-id', `${sanitizePathKey(eventId)}.json`),
    logFile: (date: string) => join(dataRoot, 'logs', `${date}.log`),
    workspaceDir: (workId: string) => join(wakeRoot, 'workspaces', workId),
    transcriptWorkDir: (workId: string) => join(dataRoot, 'transcripts', workId),
    transcriptSessionDir: (workId: string, sessionKey: string) =>
      join(dataRoot, 'transcripts', workId, sanitizePathKey(sessionKey)),
    resourceIndexRoot: join(dataRoot, 'state', 'index'),
    resourceIndexShardFile: (shard: string) => join(dataRoot, 'state', 'index', `${shard}.json`),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/paths.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite to find any test relying on the old flat layout**

Run: `npm test`
Expected: some failures are likely — any test that asserts a literal path like `join(wakeRoot, 'events', ...)` instead of going through `createWakePaths`/its returned functions needs updating to expect the `.wake/`-nested path, or to build its expectation via `createWakePaths(wakeRoot).eventFile(...)` instead of a hand-built literal. Fix each failure by updating the *expectation*, not the production code — `paths.ts`'s new values are correct by this task's design.

- [ ] **Step 6: Commit**

```bash
git add src/lib/paths.ts test/
git commit -m "Split paths.ts into a visible project root and a hidden .wake/ data root"
```

---

### Task 2: `scaffoldWakeHome` scaffolds the new layout, drops docker script copying

**Files:**

- Modify: `src/cli/scaffold-assets.ts`
- Test: `test/cli/scaffold-assets.test.ts`

**Interfaces:**

- Consumes: `createWakePaths` from Task 1 (use it, rather than hand-building directory names, to enumerate what to `mkdir`).

- [ ] **Step 1: Write the failing tests**

Add to `test/cli/scaffold-assets.test.ts`:

```typescript
it('creates .wake/-nested runtime directories, not flat top-level ones', async () => {
  const wakeRoot = await makeTempWakeRoot();
  await scaffoldWakeHome({ wakeRoot, repoRoot });

  await expect(access(join(wakeRoot, '.wake', 'events'))).resolves.toBeUndefined();
  await expect(access(join(wakeRoot, '.wake', 'state'))).resolves.toBeUndefined();
  await expect(access(join(wakeRoot, '.wake', 'runs'))).resolves.toBeUndefined();
  await expect(access(join(wakeRoot, '.wake', 'sources'))).resolves.toBeUndefined();
  await expect(access(join(wakeRoot, '.wake', 'locks'))).resolves.toBeUndefined();
  await expect(access(join(wakeRoot, '.wake', 'logs'))).resolves.toBeUndefined();
  await expect(access(join(wakeRoot, 'workspaces'))).resolves.toBeUndefined();
  await expect(access(join(wakeRoot, 'events'))).rejects.toThrow();
});

it('does not scaffold docker/ at all', async () => {
  const wakeRoot = await makeTempWakeRoot();
  await scaffoldWakeHome({ wakeRoot, repoRoot });

  await expect(access(join(wakeRoot, 'docker'))).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/scaffold-assets.test.ts -t ".wake|does not scaffold docker"`
Expected: FAIL — directories are currently created flat, and `docker/` (with `Dockerfile`/`setup.sh`/`log-command.sh`) is currently always copied.

- [ ] **Step 3: Implement**

In `src/cli/scaffold-assets.ts`:

1. Remove the `dockerAssetNames` constant and its `copyAssets(repoRoot, 'docker', ...)` call inside `scaffoldWakeHome`.
2. Replace the hand-listed `runtimeDirectoryNames` array with directory creation derived from `createWakePaths`: import `createWakePaths` from `../lib/paths.js`, call it once (`const paths = createWakePaths(wakeRoot)`), and `mkdir` the distinct parent directories of every path it returns that this scaffold step is responsible for pre-creating (`paths.dataRoot`, `join(paths.dataRoot, 'events')`, `join(paths.dataRoot, 'state')`, `join(paths.dataRoot, 'runs')`, `join(paths.dataRoot, 'sources')`, `join(paths.dataRoot, 'repos')`, `join(paths.dataRoot, 'locks')`, `join(paths.dataRoot, 'logs')`, `join(paths.dataRoot, 'control')`, `join(paths.dataRoot, 'container-home')`, `join(paths.dataRoot, 'transcripts')`, `paths.workspaceRoot`) — keep this as an explicit array of directory paths (not deriving structurally from every returned key, since several keys are file paths, not directories) but build the array from `paths.dataRoot`/`paths.workspaceRoot` rather than string-literal-joining `wakeRoot` directly, so the nesting can't drift out of sync with `paths.ts` again.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/scaffold-assets.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/cli/scaffold-assets.ts test/cli/scaffold-assets.test.ts
git commit -m "Scaffold the .wake/-nested layout; stop copying docker/ scripts at init"
```

---

### Task 3: Consistent `--wake-root` default + `--host` escape hatch + auto-delegation

**Files:**

- Modify: `src/main.ts`
- Test: `test/cli/main.test.ts`

**Interfaces:**

- Consumes: nothing new from earlier tasks in this plan (independent of Task 1/2's path values — this only changes which directory is chosen as `wakeRoot` and whether the command execs into the sandbox).
- Produces: exported (for testing) `hasDockerfile(wakeRoot: string): Promise<boolean>` helper.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli/main.test.ts`. This requires refactoring `dispatchMainCommand`'s injected handlers to be observable for whether they were called with the *sandboxed* args or ran directly — reuse the existing `runTick`/`runStart`/`runUi` spy pattern already in the file, and add a new injected dependency the real `main()` wiring will supply but tests can fake: `execIntoSandbox: (args: string[]) => Promise<never>` (called instead of `runTick`/etc. when auto-delegating; in real usage this replaces the process via `sandbox exec`, so it never returns — model it as `Promise<never>` and have the fake reject or the test only assert it was called, not awaited to completion).

```typescript
describe('sandbox auto-delegation', () => {
  it('auto-delegates a runtime command into the sandbox when docker/Dockerfile exists', async () => {
    // set up a temp dir containing docker/Dockerfile
    const wakeRoot = await makeTempWakeRootWithDockerfile(); // new local helper, mkdir + write docker/Dockerfile
    const execIntoSandbox = vi.fn(async () => {});
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['tick', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick,
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
    });

    expect(execIntoSandbox).toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
  });

  it('runs on the host when docker/Dockerfile does not exist', async () => {
    const wakeRoot = await makeTempWakeRootWithoutDockerfile();
    const execIntoSandbox = vi.fn(async () => {});
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['tick', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick,
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
    });

    expect(runTick).toHaveBeenCalled();
    expect(execIntoSandbox).not.toHaveBeenCalled();
  });

  it('--host bypasses auto-delegation even when docker/Dockerfile exists', async () => {
    const wakeRoot = await makeTempWakeRootWithDockerfile();
    const execIntoSandbox = vi.fn(async () => {});
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['tick', '--wake-root', wakeRoot, '--host'],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick,
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
    });

    expect(runTick).toHaveBeenCalled();
    expect(execIntoSandbox).not.toHaveBeenCalled();
  });

  it('does not auto-delegate init/sandbox/stop even when docker/Dockerfile exists', async () => {
    const wakeRoot = await makeTempWakeRootWithDockerfile();
    const execIntoSandbox = vi.fn(async () => {});
    const runSandbox = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['sandbox', 'build', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox,
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
    });

    expect(runSandbox).toHaveBeenCalled();
    expect(execIntoSandbox).not.toHaveBeenCalled();
  });
});
```

Add the two temp-dir helpers near the top of the test file (or reuse an existing temp-dir helper from `scaffold-assets.test.ts`'s pattern if `main.test.ts` already has one — check first):

```typescript
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeTempWakeRootWithDockerfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wake-main-test-'));
  await mkdir(join(dir, 'docker'), { recursive: true });
  await writeFile(join(dir, 'docker', 'Dockerfile'), 'FROM node:20-slim\n', 'utf8');
  return dir;
}

async function makeTempWakeRootWithoutDockerfile(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'wake-main-test-'));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/main.test.ts -t "sandbox auto-delegation"`
Expected: FAIL — `dispatchMainCommand`'s input type has no `execIntoSandbox` field yet, and there's no `--host`/Dockerfile-presence branching.

- [ ] **Step 3: Implement**

In `src/main.ts`, add near `resolvePackageRoot` (or any other small top-level helper):

```typescript
export async function hasDockerfile(wakeRoot: string): Promise<boolean> {
  try {
    await access(resolve(wakeRoot, 'docker', 'Dockerfile'));
    return true;
  } catch {
    return false;
  }
}
```

(Add `access` to the existing `node:fs/promises` import in `main.ts` if not already imported — check first with `grep -n "from 'node:fs/promises'" src/main.ts`.)

Add `execIntoSandbox: (args: string[]) => Promise<unknown>` to `dispatchMainCommand`'s `input` type, alongside the existing `runInit`/`runSandbox`/etc. fields.

Locate the branches for `tick`, `start`, `ui`, `smoke`, `correlate` (around lines 523–561) — each currently looks like:

```typescript
if (command === 'tick') {
  await input.runTick(input.args.slice(1));
  return;
}
```

For exactly these five commands (not `init`, `sandbox`, `stop`, which are unaffected), wrap the dispatch in a shared decision. Introduce a helper near the top of `dispatchMainCommand`, computed once after `command` is known to be one of the five runtime commands:

```typescript
const runtimeCommands = new Set(['tick', 'start', 'ui', 'smoke', 'correlate']);
if (runtimeCommands.has(command)) {
  const commandArgs = input.args.slice(1);
  const wakeRoot = resolve(
    readFlagBeforeCommandTerminator('--wake-root', commandArgs) ?? process.cwd(),
  );
  const host = commandArgs.includes('--host');

  if (!host && (await hasDockerfile(wakeRoot))) {
    await input.execIntoSandbox(input.args);
    return;
  }

  const hostArgs = commandArgs.filter((arg) => arg !== '--host');
  if (command === 'tick') {
    await input.runTick(hostArgs);
  } else if (command === 'start') {
    await input.runStart(hostArgs);
  } else if (command === 'ui') {
    await input.runUi(hostArgs);
  } else if (command === 'smoke') {
    await input.runSmoke(hostArgs);
  } else {
    await input.runCorrelate(hostArgs);
  }
  return;
}
```

Place this block **before** the existing individual `if (command === 'tick')` / `'start'` / `'ui'` / `'smoke'` / `'correlate'` branches, and delete those five now-dead branches (their logic is absorbed above). Leave `init`, `sandbox`/`stop` branches untouched.

Update every remaining `resolve(cwd, '.wake')`-style default elsewhere in `main.ts` (the `runTick`/`runStart`/`runUi` wiring functions themselves, around lines 238, 443, 471 per earlier inspection) from `readFlagBeforeCommandTerminator('--wake-root', args) ?? resolve(process.cwd(), '.wake')` to `readFlagBeforeCommandTerminator('--wake-root', args) ?? process.cwd()`, matching what `sandbox`'s wiring (line 578) already does — these are the functions `dispatchMainCommand` calls into (`runTick`, `runStart`, `runUi` as defined in `main()`), so this keeps their own default resolution consistent with the new dispatch-level check above (which only computes `wakeRoot` to decide on delegation — the actual command implementations still resolve their own `wakeRoot` independently from `hostArgs`).

Finally, wire the real `execIntoSandbox` implementation in `main()`'s `dispatchMainCommand(...)` call: it should be equivalent to what `wake.sh`/`wake.ps1` do today — rewrite `--wake-root <value>` (or append one if absent) to `/wake`, then `runSandbox(['exec', '--', 'node', '/app/dist/src/main.js', ...rewrittenArgs])`. Implement as:

```typescript
execIntoSandbox: async (args: string[]) => {
  const withoutHostFlag = args.filter((arg) => arg !== '--host');
  const wakeRootIndex = withoutHostFlag.indexOf('--wake-root');
  const rewritten =
    wakeRootIndex === -1
      ? [...withoutHostFlag, '--wake-root', '/wake']
      : withoutHostFlag.map((arg, index) => (index === wakeRootIndex + 1 ? '/wake' : arg));

  await runSandbox(['exec', '--', 'node', '/app/dist/src/main.js', ...rewritten]);
},
```

(`runSandbox` here is the same function reference already defined in `main()` and passed as `runSandbox` to `dispatchMainCommand` — reuse it directly rather than duplicating its body.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/main.test.ts`
Expected: PASS (full file — confirms no regression to pre-existing routing tests, which need an `execIntoSandbox: async () => {}` field added to their existing `dispatchMainCommand` call objects; add it to every pre-existing test in this file that constructs a full handler object)

- [ ] **Step 5: Commit**

```bash
git add src/main.ts test/cli/main.test.ts
git commit -m "Fold sandbox routing into dispatchMainCommand with a --host escape hatch"
```

---

### Task 4: `wake sandbox setup` replaces `docker/setup.sh`

**Files:**

- Create: `src/cli/sandbox-setup-command.ts`
- Modify: `src/cli/sandbox-command.ts`
- Modify: `src/main.ts` (wiring)
- Test: `test/cli/sandbox-setup-command.test.ts`

**Interfaces:**

- Produces: `export async function runSandboxSetupCommand(deps: { prompt: (message: string) => Promise<boolean>; runInteractive: (command: string, args: string[]) => Promise<void>; ensureSshKey: () => Promise<void>; prepareCodexHome: () => Promise<void>; log: (message: string) => void }): Promise<void>`, exported from `src/cli/sandbox-setup-command.ts`. Dependency-injected so the interactive prompts and subprocess spawns are fakeable in tests — no real `gh`/`claude`/`codex`/`agent` CLI invocation in unit tests.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/cli/sandbox-setup-command.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runSandboxSetupCommand } from '../../src/cli/sandbox-setup-command.js';

describe('runSandboxSetupCommand', () => {
  it('prepares the codex home and ssh key unconditionally, then prompts for each CLI auth', async () => {
    const log = vi.fn();
    const runInteractive = vi.fn(async () => {});
    const prompt = vi.fn(async (message: string) => message.includes('GitHub'));
    const ensureSshKey = vi.fn(async () => {});
    const prepareCodexHome = vi.fn(async () => {});

    await runSandboxSetupCommand({ prompt, runInteractive, ensureSshKey, prepareCodexHome, log });

    expect(prepareCodexHome).toHaveBeenCalledOnce();
    expect(ensureSshKey).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledTimes(4); // GitHub, Claude, Codex, Cursor
    expect(runInteractive).toHaveBeenCalledWith('gh', ['auth', 'login']);
    expect(runInteractive).toHaveBeenCalledWith('gh', ['auth', 'setup-git']);
    expect(runInteractive).not.toHaveBeenCalledWith('claude', expect.anything());
  });

  it('skips a CLI auth step entirely when its prompt is declined', async () => {
    const runInteractive = vi.fn(async () => {});
    const prompt = vi.fn(async () => false);

    await runSandboxSetupCommand({
      prompt,
      runInteractive,
      ensureSshKey: vi.fn(async () => {}),
      prepareCodexHome: vi.fn(async () => {}),
      log: vi.fn(),
    });

    expect(runInteractive).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/sandbox-setup-command.test.ts`
Expected: FAIL — `src/cli/sandbox-setup-command.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/cli/sandbox-setup-command.ts`, porting `docker/setup.sh`'s behavior (Codex home bootstrap, SSH keygen-if-missing, then y/N-gated `gh auth login && gh auth setup-git` / `claude auth login --claudeai` / `codex login` / `agent login`):

```typescript
export async function runSandboxSetupCommand(deps: {
  prompt: (message: string) => Promise<boolean>;
  runInteractive: (command: string, args: string[]) => Promise<void>;
  ensureSshKey: () => Promise<void>;
  prepareCodexHome: () => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  deps.log('Wake sandbox setup starting.');

  await deps.prepareCodexHome();
  await deps.ensureSshKey();

  if (await deps.prompt('Configure GitHub auth? [y/N]')) {
    deps.log(
      'Optional best practice: sign in with a dedicated GitHub identity for Wake-managed agent work, rather than your main personal account. Make sure it has only the repository access Wake needs.',
    );
    await deps.runInteractive('gh', ['auth', 'login']);
    await deps.runInteractive('gh', ['auth', 'setup-git']);
  } else {
    deps.log('Skipping GitHub auth setup.');
  }

  if (await deps.prompt('Configure Claude auth? [y/N]')) {
    await deps.runInteractive('claude', ['auth', 'login', '--claudeai']);
  } else {
    deps.log('Skipping Claude auth setup.');
  }

  if (await deps.prompt('Configure Codex auth? [y/N]')) {
    await deps.runInteractive('codex', ['login']);
  } else {
    deps.log('Skipping Codex auth setup.');
  }

  if (await deps.prompt('Configure Cursor auth? [y/N]')) {
    await deps.runInteractive('agent', ['login']);
  } else {
    deps.log('Skipping Cursor auth setup.');
  }
}
```

In `src/cli/sandbox-command.ts`, change the `setup` subcommand branch from `bash /wake/docker/setup.sh` invoked inside the container to running `wake sandbox-setup` inside the container instead (the container has a working `wake`/`node .../main.js` regardless of `dev.mode`, per the dev-mode-packaged-builds plan):

```typescript
if (subcommand === 'setup') {
  await input.docker.exec(
    input.config.sandbox.containerName,
    ['node', '/app/dist/src/main.js', 'sandbox-setup'],
    { interactive: true },
  );
  return;
}
```

In `main.ts`, add a `sandbox-setup` command branch to `dispatchMainCommand` (this one runs *inside* the container, invoked by the `docker exec` above — it is a real top-level `wake` subcommand, not nested under `sandbox`) that calls a new `runSandboxSetup` handler wired with real `readline`-based prompts (reuse the `node:readline/promises` `createInterface` pattern already used in `src/cli/sandbox-resume.ts` — check that file for the exact pattern before implementing the real `prompt` function), real `ensureSshKey`/`prepareCodexHome` implementations using `node:child_process` `spawn`/`existsSync` (port directly from `setup.sh`'s `ssh-keygen -t ed25519 -f /home/wake/.ssh/id_ed25519 -N ""` and the `codex_bootstrap_home`/`codex_runtime_home` copy logic), and `runInteractive` as a thin wrapper around the existing `spawn(..., { stdio: 'inherit' })` pattern (reuse `runCommand` from `main.ts` directly, since it already does exactly this).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/sandbox-setup-command.test.ts test/cli/sandbox-command.test.ts`
Expected: PASS (both files)

- [ ] **Step 5: Commit**

```bash
git add src/cli/sandbox-setup-command.ts src/cli/sandbox-command.ts src/main.ts test/cli/sandbox-setup-command.test.ts
git commit -m "Add wake sandbox-setup, replacing the mounted docker/setup.sh script"
```

---

### Task 5: Inline `log-command.sh`'s scrub/mirror logic into `wake sandbox exec`

**Files:**

- Create: `src/cli/sandbox-exec-logging.ts`
- Modify: `src/cli/sandbox-command.ts`
- Modify: `src/cli/sandbox-logging.ts` (or remove it if fully superseded — check whether `buildSandboxLoggedCommand` has any other callers first: `grep -rn "buildSandboxLoggedCommand" src/`)
- Test: `test/cli/sandbox-exec-logging.test.ts`

**Interfaces:**

- Produces: `export function scrubSecrets(line: string): string`, `export function wrapAndLog(input: { label: string; command: string[]; onStdout: (line: string) => void; onStderr: (line: string) => void; spawnCommand: (command: string, args: string[]) => { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; }; ... }): Promise<number>` — exact shape to be finalized by whoever implements this task against `docker-cli.ts`'s actual `exec` signature (see Step 1); the important, non-negotiable piece is `scrubSecrets`, which must be a pure, directly-unit-tested function.

- [ ] **Step 1: Confirm the current `docker.exec`/`deps.run` stdio behavior before designing the wrapper**

Run: `sed -n '146,157p' src/adapters/docker/docker-cli.ts` and `sed -n '122,144p' src/main.ts`. Confirmed at plan-writing time: `docker.exec` always calls through `deps.run` (→ `runCommand` in `main.ts`), which spawns with `stdio: 'inherit'` — i.e. today's `docker exec` output goes straight to the terminal, unobserved by the Node process. The `sandbox exec` subcommand (not `setup`, which passes `interactive: true` for `-it`) always calls `docker.exec` **without** `interactive: true`, so it already runs as `-i` (no TTY) — this makes it safe to switch `sandbox exec` specifically from inherited stdio to piped stdio without breaking any interactive/TTY use case, since it isn't one today.

- [ ] **Step 2: Write the failing test for `scrubSecrets`**

```typescript
// test/cli/sandbox-exec-logging.test.ts
import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../../src/cli/sandbox-exec-logging.js';

describe('scrubSecrets', () => {
  it('redacts TOKEN/SECRET/PASSWORD/KEY-suffixed env assignments', () => {
    expect(scrubSecrets('GITHUB_TOKEN=abc123')).toBe('GITHUB_TOKEN=[REDACTED]');
    expect(scrubSecrets('MY_SECRET_VALUE=xyz')).toBe('MY_SECRET_VALUE=[REDACTED]');
    expect(scrubSecrets('DB_PASSWORD=hunter2')).toBe('DB_PASSWORD=[REDACTED]');
    expect(scrubSecrets('API_KEY=zzz')).toBe('API_KEY=[REDACTED]');
  });

  it('redacts GitHub token prefixes anywhere in a line', () => {
    expect(scrubSecrets('using token ghp_abcdefghijklmnop')).toBe('using token [REDACTED]');
    expect(scrubSecrets('gho_1234567890abcdef in header')).toBe('[REDACTED] in header');
    expect(scrubSecrets('github_pat_ABC123 present')).toBe('[REDACTED] present');
  });

  it('leaves lines with no secrets unchanged', () => {
    expect(scrubSecrets('hello world')).toBe('hello world');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/cli/sandbox-exec-logging.test.ts`
Expected: FAIL — `src/cli/sandbox-exec-logging.ts` doesn't exist yet.

- [ ] **Step 4: Implement `scrubSecrets`, ported verbatim in intent from `log-command.sh`'s `sed` pattern**

Create `src/cli/sandbox-exec-logging.ts`:

```typescript
const ENV_SECRET_PATTERN = /([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY)[A-Za-z0-9_]*=)[^\s]+/gi;
const GITHUB_TOKEN_PATTERN = /(?:gho|ghp|github_pat)_[A-Za-z0-9_]+/g;

export function scrubSecrets(line: string): string {
  return line.replace(ENV_SECRET_PATTERN, '$1[REDACTED]').replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/cli/sandbox-exec-logging.test.ts`
Expected: PASS

- [ ] **Step 6: Commit `scrubSecrets` on its own before tackling the process-wrapping change**

```bash
git add src/cli/sandbox-exec-logging.ts test/cli/sandbox-exec-logging.test.ts
git commit -m "Add scrubSecrets, a tested TypeScript port of log-command.sh's redaction regex"
```

- [ ] **Step 7: Wire `scrubSecrets` into the `sandbox exec` subcommand's live output**

This step changes `docker.exec`'s invocation path specifically for the `sandbox exec` subcommand to pipe stdout/stderr through Node (instead of `stdio: 'inherit'`), line-buffer each stream, run every line through `scrubSecrets`, and write to `process.stdout`/`process.stderr` — replicating `log-command.sh`'s `mirror_stdout`/`mirror_stderr`/`scrub` behavior, minus the `/proc/1/fd/*` container-PID-1 mirroring (that was a container-internal detail for the resident supervisor's log capture, not relevant once this runs as a plain `docker exec` from the host). The `emit_check` preflight probes (`wake-config`, `prompts-root`, `gh-auth-status`, etc.) in `log-command.sh` are **not** ported here — that diagnostic reporting is superseded by `wake doctor` (a separate, already-specified follow-on piece; do not duplicate it here).

Add a new exported function to `docker-cli.ts` (or a new method on the object `createDockerCli` returns) — `execCaptured(containerName, command, { onStdout, onStderr }): Promise<void>` — spawning `docker exec -i <containerName> <command...>` with `stdio: ['inherit', 'pipe', 'pipe']`, wiring `child.stdout`/`child.stderr` through a `node:readline` line-reader per stream, calling `onStdout(scrubSecrets(line))`/`onStderr(scrubSecrets(line))` for each line, and still rejecting on non-zero exit the same way `runCommand` does today. In `sandbox-command.ts`'s `exec` subcommand branch, call this new method instead of `input.docker.exec(...)` via `buildSandboxLoggedCommand`, passing `onStdout: (line) => console.log(line)` / `onStderr: (line) => console.error(line)`. Delete `buildSandboxLoggedCommand` and `src/cli/sandbox-logging.ts` once confirmed to have no other callers (checked in Step 1's `grep`).

Write a test in `test/adapters/docker-cli.test.ts` (or wherever `docker-cli.test.ts` already lives) asserting `execCaptured` scrubs a secret-bearing line before it reaches `onStdout`, using a faked `spawn` (match whatever spawn-faking pattern that test file already uses for `build`/`up`/etc.).

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/adapters/docker-cli.test.ts test/cli/sandbox-command.test.ts`
Expected: PASS (both files)

- [ ] **Step 9: Commit**

```bash
git add src/adapters/docker/docker-cli.ts src/cli/sandbox-command.ts test/adapters/docker-cli.test.ts
git rm src/cli/sandbox-logging.ts test/cli/sandbox-logging.test.ts 2>/dev/null || true
git commit -m "Inline log-command.sh's scrub/mirror logic into wake sandbox exec"
```

---

### Task 6: `wake sandbox-entrypoint` replaces `docker/entrypoint.sh`

**Files:**

- Create: `src/cli/sandbox-entrypoint-command.ts`
- Modify: `src/main.ts` (wiring, new top-level `sandbox-entrypoint` command)
- Modify: `docker/Dockerfile`, `docker/Dockerfile.packaged` (the `ENTRYPOINT` line — already anticipated as `["node", "/app/dist/src/main.js", "sandbox-entrypoint"]` / `["node", ".../main.js", "sandbox-entrypoint"]` in the dev-mode-packaged-builds plan; if that plan already landed, this task just needs to confirm the Dockerfiles already point at this subcommand — if not, update them now)
- Test: `test/cli/sandbox-entrypoint-command.test.ts`

**Interfaces:**

- Produces: `export async function runSandboxEntrypointCommand(deps: { env: NodeJS.ProcessEnv; spawnDetached: (command: string, args: string[]) => { pid: number }; writeFile: (path: string, content: string) => Promise<void>; sleep: (ms: number) => Promise<void>; discoverNgrokUrl: () => Promise<string | undefined>; log: (message: string) => void }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/cli/sandbox-entrypoint-command.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runSandboxEntrypointCommand } from '../../src/cli/sandbox-entrypoint-command.js';

describe('runSandboxEntrypointCommand', () => {
  it('starts the UI process when WAKE_UI_ENABLED=true', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_UI_ENABLED: 'true', WAKE_UI_PORT: '4317' },
      spawnDetached,
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['ui', '--wake-root', '/wake', '--host', '0.0.0.0', '--port', '4317']),
    );
  });

  it('does not start the UI process when WAKE_UI_ENABLED is unset', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 123 }));

    await runSandboxEntrypointCommand({
      env: {},
      spawnDetached,
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).not.toHaveBeenCalledWith('node', expect.arrayContaining(['ui']));
  });

  it('starts the resident wake start loop when WAKE_START_ENABLED=true', async () => {
    const spawnDetached = vi.fn(() => ({ pid: 456 }));

    await runSandboxEntrypointCommand({
      env: { WAKE_START_ENABLED: 'true' },
      spawnDetached,
      writeFile: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      discoverNgrokUrl: vi.fn(async () => undefined),
      log: vi.fn(),
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['start', '--wake-root', '/wake']),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/sandbox-entrypoint-command.test.ts`
Expected: FAIL — `src/cli/sandbox-entrypoint-command.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/cli/sandbox-entrypoint-command.ts`, porting `docker/entrypoint.sh`'s UI-start / ngrok-tunnel-discovery / `wake start` supervise-and-restart loop into TypeScript, using the injected `spawnDetached`/`writeFile`/`sleep`/`discoverNgrokUrl`/`log` dependencies so none of it needs a real child process or filesystem in unit tests. Match the original script's env-var contract exactly (`WAKE_UI_ENABLED`, `WAKE_UI_PORT` default `4317`, `WAKE_UI_TOKEN`, `WAKE_UI_TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`, `WAKE_START_ENABLED`, `WAKE_START_RESTART_DELAY_SECONDS` default `10`) and target file (`/wake/control-plane-ui-url`) so nothing else that reads these needs to change. The supervise-and-restart loop for `wake start` (the `while true; do ... wait; sleep; done` in the original) becomes an `async` loop calling `deps.spawnDetached('node', ['/app/dist/src/main.js', 'start', '--wake-root', '/wake'])`, awaiting its exit via whatever signal `spawnDetached`'s real implementation exposes (design this with a `waitForExit: (pid: number) => Promise<number>` dependency added alongside `spawnDetached` if the child-process exit needs to be awaited — the real implementation wires this to Node's `child.on('exit', ...)`), then `deps.sleep(restartDelaySeconds * 1000)` before looping.

Wire a new `sandbox-entrypoint` command into `dispatchMainCommand` (alongside `init`/`sandbox`/`stop` — it also runs on the host/container directly, never through the sandbox-auto-delegation path from Task 3, since it's the thing *running inside* the container) and a real dependency bundle in `main()` using actual `spawn`, `fs/promises.writeFile`, `setTimeout`-based `sleep`, and an `discoverNgrokUrl` implementation porting the original script's polling `http://127.0.0.1:4040/api/tunnels` fetch loop (use Node's built-in `fetch` rather than the original's raw `node -e` `http.get` snippet — simpler and already available in Node 20).

Update `docker/Dockerfile`'s and `docker/Dockerfile.packaged`'s `ENTRYPOINT` lines to `["node", "/app/dist/src/main.js", "sandbox-entrypoint"]` (source mode) and the packaged-mode equivalent respectively — check the current `docker/Dockerfile.packaged` content first (created in the dev-mode-packaged-builds plan) to see if it already has this `ENTRYPOINT`; if so, no edit needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/sandbox-entrypoint-command.test.ts test/cli/main.test.ts`
Expected: PASS (both files)

- [ ] **Step 5: Commit**

```bash
git add src/cli/sandbox-entrypoint-command.ts src/main.ts docker/Dockerfile docker/Dockerfile.packaged test/cli/sandbox-entrypoint-command.test.ts
git commit -m "Add wake sandbox-entrypoint, replacing docker/entrypoint.sh"
```

---

### Task 7: `dockerAssetNames`/launcher cleanup

**Files:**

- Modify: `src/cli/scaffold-assets.ts`

- [ ] **Step 1: Confirm `dockerAssetNames` was already fully removed in Task 2**

Run: `grep -n "dockerAssetNames\|setup.sh\|log-command.sh" src/cli/scaffold-assets.ts`
Expected: no matches (Task 2 already removed the `docker/` copy entirely). If any reference remains, remove it now.

- [ ] **Step 2: Simplify the generated launcher scripts**

`wake.sh`/`wake.ps1` no longer need to embed sandbox-routing logic (Task 3 moved that into `dispatchMainCommand` itself). Locate `writeLaunchers` in `scaffold-assets.ts` and replace both generated scripts' bodies with a one-line delegation to the global `wake` binary — e.g. `wake.sh` becomes:

```bash
#!/usr/bin/env bash
exec wake "$@" --wake-root "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```

and `wake.ps1`'s equivalent using `$PSScriptRoot`. Keep them only as a convenience so `./wake.sh tick` continues to work from inside a wake-home without typing `--wake-root .` — they are no longer load-bearing for sandbox routing.

- [ ] **Step 3: Run the scaffold test suite**

Run: `npx vitest run test/cli/scaffold-assets.test.ts`
Expected: PASS — update any test asserting on the old launcher content to match the simplified script bodies.

- [ ] **Step 4: Commit**

```bash
git add src/cli/scaffold-assets.ts test/cli/scaffold-assets.test.ts
git commit -m "Simplify generated launcher scripts now that sandbox routing lives in the CLI"
```

---

### Task 8: Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/development.md`

- [ ] **Step 1: README directory layout**

Update the directory-layout description (and "Local and inspectable" callout) to the new `wake-home/` + `wake-home/.wake/` tree from the spec.

- [ ] **Step 2: `docs/development.md` — manual upgrade note**

Add a short "Upgrading an existing wake-home to the new layout" section: move `.wake/`-bound directories (`repos/`, `logs/`, `container-home/`, `events/`, `events-by-id/`, `state/`, `runs/`, `sources/`, `locks/`, `control/`, `ledger.json`, `PAUSE`, `transcripts/`) under a new `.wake/` subdirectory by hand; delete `docker/setup.sh`, `docker/log-command.sh`, `docker/entrypoint.sh` (now unused); confirm `docker/Dockerfile`'s `ENTRYPOINT` points at `sandbox-entrypoint`, editing it by hand if not (it's user-owned and never auto-rewritten); re-run `wake sandbox build` to pick up the new entrypoint.

- [ ] **Step 3: Verify formatting and commit**

Run: `npx prettier --check README.md docs/development.md`, fix with `npx prettier --write --end-of-line lf <file>` if needed, then:

```bash
git add README.md docs/development.md
git commit -m "Document the new wake-home/.wake/ layout and manual upgrade steps"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: lint, format:check, build, and test all pass (ignoring the known Windows CRLF false-positive on untouched files per `CLAUDE.md`).

- [ ] **Step 2: Commit if verify required any fixes**

```bash
git add -A
git commit -m "Fix verify failures"
```
