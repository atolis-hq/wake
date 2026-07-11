# Safe Stop and Automated Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close roadmap items #111 (safe stop) and 2.6 (automated self-update with rollback and self-heal) — a `wake stop` that waits for active runs before stopping the sandbox container, and a `wake sandbox self-update` command that polls for new release tags, rebuilds a versioned image, health-checks it, and rolls back + files a GitHub issue on failure.

**Architecture:** Both features are host-side CLI additions layered onto the existing `sandbox-command.ts` dispatcher and `DockerCli` adapter — no changes to `core/` (tick loop, policy engine, lifecycle) since deployment is infrastructure, not agent orchestration. Self-update reuses the durable `RunRecord`/`stateStore` machinery already in `src/adapters/fs/state-store.ts` to detect in-flight runs, and adds one new host-side ledger file (outside `.wake/`'s zod-validated schema) to track applied/rolled-back image tags.

**Tech Stack:** TypeScript, Vitest, Node `node:child_process`/`node:fs`, Docker CLI (shelled out), `git` CLI (shelled out), `gh` CLI (shelled out, already the repo's GitHub auth mechanism via `resolveGitHubToken`).

## Global Constraints

- Match existing test conventions: Vitest, `describe/it`, manual `vi.fn()` mock objects, no `jest.mock`. See `test/cli/sandbox-command.test.ts` and `test/adapters/docker-cli.test.ts`.
- `core/` must never import a concrete adapter directly (CLAUDE.md) — these features live entirely in `src/cli/` and `src/adapters/docker/`, not `src/core/`.
- Any change to `config.json`'s zod schema (`src/domain/schema.ts`) must be reflected in `docs/configuration.md`.
- Do not touch the currently-running `wake-sandbox` Docker container/image during development or testing — it is live. All manual rehearsal must use an isolated container name and wake-root (e.g. `wake-sandbox-selfupdate-rehearsal`, a scratch directory).
- Existing `docker.down('wake-sandbox')` test (`test/adapters/docker-cli.test.ts:317`) expects exactly `['stop', 'wake-sandbox']` — the new timeout parameter must be optional and default to omitting the `--time` flag, so this test keeps passing unchanged.
- `npm run verify` (build + test) must pass before this plan is considered done.

---

## File Structure

- Modify `src/adapters/docker/docker-cli.ts` — add optional stop-timeout support to `down()` and `update()`.
- Create `src/cli/stop-command.ts` — waits for active runs, then stops the container. Used by both `wake stop` and `wake sandbox stop`.
- Modify `src/cli/sandbox-command.ts` — add `stop` and `self-update` subcommand routing.
- Modify `src/main.ts` — add top-level `stop` command, wire new deps (`git`, `issueReporter`, `sleep`) into `runSandbox`.
- Modify `src/cli/scaffold-assets.ts` — add `stop` to the host-side launcher case list (bash + PowerShell).
- Create `src/adapters/fs/self-update-ledger.ts` — read/write the host-side ledger (`lastAppliedTag`, `lastKnownGoodTag`, `badTags`).
- Create `src/cli/self-update-command.ts` — orchestrates tag detection, git checkout, build, update, health-check, rollback, issue-filing.
- Modify `src/domain/schema.ts` and `docs/configuration.md` — add `sandbox.imageRepository` config field (base image name, tag applied per-release by self-update).
- Modify `docs/development.md` and `README.md` — document `wake stop` and `wake sandbox self-update`.
- Delete `scripts/watch-main-update.ps1` — it references `update.ps1`/`update.sh` files that don't exist anywhere in the repo or scaffold; dead code superseded by `wake sandbox self-update`.
- Tests: `test/adapters/docker-cli.test.ts`, `test/cli/stop-command.test.ts` (new), `test/cli/sandbox-command.test.ts`, `test/cli/main.test.ts`, `test/cli/scaffold-assets.test.ts` (new or existing), `test/adapters/self-update-ledger.test.ts` (new), `test/cli/self-update-command.test.ts` (new).

---

### Task 1: Docker stop timeout support

**Files:**
- Modify: `src/adapters/docker/docker-cli.ts`
- Test: `test/adapters/docker-cli.test.ts`

**Interfaces:**
- Produces: `down(containerName: string, options?: { timeoutSeconds?: number }): Promise<void>`; `DockerUpInput` gains optional `stopTimeoutSeconds?: number`, applied only to the `stop` call inside `update()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/adapters/docker-cli.test.ts` (after the existing `'stops the sandbox container'` test):

```typescript
  it('stops the sandbox container with a grace period when a timeout is provided', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.down('wake-sandbox', { timeoutSeconds: 3600 });

    expect(calls).toEqual([['stop', '--time', '3600', 'wake-sandbox']]);
  });

  it('passes the stop timeout through update when replacing a running container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => 'running',
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.update({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      stopTimeoutSeconds: 3600,
    });

    expect(calls).toEqual([
      ['stop', '--time', '3600', 'wake-sandbox'],
      ['rm', 'wake-sandbox'],
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        'wake-sandbox',
      ],
    ]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/adapters/docker-cli.test.ts`
Expected: FAIL — `down` called with 2 args but implementation ignores the second; actual calls array won't include `--time`.

- [ ] **Step 3: Implement the minimal change**

In `src/adapters/docker/docker-cli.ts`, add `stopTimeoutSeconds` to `DockerUpInput` (after `ui?: DockerUiInput;`):

```typescript
export type DockerUpInput = {
  image: string;
  containerName: string;
  wakeRoot: string;
  containerHomeRoot: string;
  containerMountPath: string;
  containerHomeMountPath: string;
  extraMounts?: Array<{
    source: string;
    target: string;
    readOnly?: boolean | undefined;
  }>;
  ui?: DockerUiInput;
  stopTimeoutSeconds?: number;
};
```

Add a shared helper above `createDockerCli` (after `buildRunArgs`):

```typescript
function buildStopArgs(containerName: string, timeoutSeconds?: number): string[] {
  return [
    'stop',
    ...(timeoutSeconds !== undefined ? ['--time', String(timeoutSeconds)] : []),
    containerName,
  ];
}
```

Replace the `update()` body's stop call and the `down()` method:

```typescript
    async update(input: DockerUpInput): Promise<void> {
      const imageExists = await deps.inspectImage(input.image);
      if (!imageExists) {
        throw new Error('Sandbox image not found. Run `wake sandbox build` first.');
      }

      const containerState = await deps.inspectContainer(input.containerName);
      if (containerState === 'running' || containerState === 'stopped') {
        if (containerState === 'running') {
          await deps.run(buildStopArgs(input.containerName, input.stopTimeoutSeconds));
        }

        await deps.run(['rm', input.containerName]);
      }

      await deps.run(buildRunArgs(input));
    },

    async down(containerName: string, options?: { timeoutSeconds?: number }): Promise<void> {
      await deps.run(buildStopArgs(containerName, options?.timeoutSeconds));
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/adapters/docker-cli.test.ts`
Expected: PASS, all tests including the pre-existing `'stops the sandbox container'` test (still calls `docker.down('wake-sandbox')` with no options, so `buildStopArgs` omits `--time` and produces `['stop', 'wake-sandbox']`).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/docker/docker-cli.ts test/adapters/docker-cli.test.ts
git commit -m "feat: support a graceful stop timeout on docker down/update"
```

---

### Task 2: Safe stop — wait for active runs, wire `wake stop` and `wake sandbox stop`

**Files:**
- Create: `src/cli/stop-command.ts`
- Test: `test/cli/stop-command.test.ts`
- Modify: `src/cli/sandbox-command.ts`
- Modify: `src/main.ts`
- Modify: `src/cli/scaffold-assets.ts`
- Test: `test/cli/sandbox-command.test.ts`, `test/cli/main.test.ts`
- Modify: `docs/development.md`, `README.md`

**Interfaces:**
- Consumes: `RunRecord` type from `src/domain/types.js` (has `status: 'running' | 'completed' | ...`); `stateStore.listRunRecords(): Promise<RunRecord[]>` from `src/adapters/fs/state-store.js`; `DockerCli.down` from Task 1.
- Produces: `waitForActiveRuns(input): Promise<void>` and `runStopCommand(input): Promise<void>` from `src/cli/stop-command.ts`, consumed by Task 4 (self-update needs to wait for active runs before rebuilding).

- [ ] **Step 1: Write the failing test for `waitForActiveRuns`**

Create `test/cli/stop-command.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { runStopCommand, waitForActiveRuns } from '../../src/cli/stop-command.js';
import type { RunRecord } from '../../src/domain/types.js';

function makeRunRecord(status: RunRecord['status']): RunRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    repo: 'atolis-hq/wake',
    issueNumber: 1,
    action: 'implement',
    status,
    startedAt: '2026-07-11T00:00:00.000Z',
  } as RunRecord;
}

describe('waitForActiveRuns', () => {
  it('returns immediately when no run is active', async () => {
    const sleep = vi.fn(async () => {});
    const listRunRecords = vi.fn(async () => [makeRunRecord('completed')]);

    await waitForActiveRuns({
      listRunRecords,
      sleep,
      logger: { info: () => {} },
    });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until the active run finishes', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const listRunRecords = vi.fn(async () => {
      calls += 1;
      return [makeRunRecord(calls < 3 ? 'running' : 'completed')];
    });

    await waitForActiveRuns({
      listRunRecords,
      sleep,
      pollIntervalMs: 10,
      logger: { info: () => {} },
    });

    expect(listRunRecords).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('throws if the timeout elapses while a run is still active', async () => {
    const sleep = vi.fn(async () => {});
    const listRunRecords = vi.fn(async () => [makeRunRecord('running')]);

    await expect(
      waitForActiveRuns({
        listRunRecords,
        sleep,
        pollIntervalMs: 10,
        timeoutMs: 25,
        logger: { info: () => {} },
      }),
    ).rejects.toThrow('Timed out after 25ms waiting for active runs to finish');
  });
});

describe('runStopCommand', () => {
  it('waits for active runs then stops the container with a grace period', async () => {
    const down = vi.fn(async () => {});
    let calls = 0;
    const listRunRecords = vi.fn(async () => {
      calls += 1;
      return [makeRunRecord(calls < 2 ? 'running' : 'completed')];
    });

    await runStopCommand({
      args: [],
      stateStore: { listRunRecords },
      docker: { down },
      containerName: 'wake-sandbox',
      sleep: vi.fn(async () => {}),
      logger: { info: () => {} },
    });

    expect(down).toHaveBeenCalledWith('wake-sandbox', { timeoutSeconds: 60 });
  });

  it('honors a --timeout-ms override', async () => {
    const down = vi.fn(async () => {});
    const listRunRecords = vi.fn(async () => [makeRunRecord('running')]);

    await expect(
      runStopCommand({
        args: ['--timeout-ms', '20'],
        stateStore: { listRunRecords },
        docker: { down },
        containerName: 'wake-sandbox',
        sleep: vi.fn(async () => {}),
        logger: { info: () => {} },
      }),
    ).rejects.toThrow('Timed out after 20ms waiting for active runs to finish');
    expect(down).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/stop-command.test.ts`
Expected: FAIL — `src/cli/stop-command.js` does not exist.

- [ ] **Step 3: Implement `stop-command.ts`**

Create `src/cli/stop-command.ts`:

```typescript
import type { RunRecord } from '../domain/types.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const STOP_GRACE_PERIOD_SECONDS = 60;

export async function waitForActiveRuns(input: {
  listRunRecords: () => Promise<RunRecord[]>;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  logger: { info: (message: string) => void };
}): Promise<void> {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  for (;;) {
    const records = await input.listRunRecords();
    const activeRuns = records.filter((record) => record.status === 'running');

    if (activeRuns.length === 0) {
      return;
    }

    if (input.timeoutMs !== undefined && Date.now() - startedAt >= input.timeoutMs) {
      throw new Error(
        `Timed out after ${input.timeoutMs}ms waiting for active runs to finish: ${activeRuns
          .map((record) => record.runId)
          .join(', ')}`,
      );
    }

    input.logger.info(
      `[wake stop] waiting for ${activeRuns.length} active run(s) to finish: ${activeRuns
        .map((record) => record.runId)
        .join(', ')}`,
    );
    await input.sleep(pollIntervalMs);
  }
}

function readNumberFlag(name: string, args: string[]): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const raw = args[index + 1];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function runStopCommand(input: {
  args: string[];
  stateStore: { listRunRecords: () => Promise<RunRecord[]> };
  docker: { down: (containerName: string, options?: { timeoutSeconds?: number }) => Promise<void> };
  containerName: string;
  sleep: (ms: number) => Promise<void>;
  logger: { info: (message: string) => void };
}): Promise<void> {
  await waitForActiveRuns({
    listRunRecords: input.stateStore.listRunRecords,
    sleep: input.sleep,
    pollIntervalMs: readNumberFlag('--poll-interval-ms', input.args),
    timeoutMs: readNumberFlag('--timeout-ms', input.args),
    logger: input.logger,
  });

  input.logger.info(`[wake stop] no active runs; stopping ${input.containerName}`);
  await input.docker.down(input.containerName, { timeoutSeconds: STOP_GRACE_PERIOD_SECONDS });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli/stop-command.test.ts`
Expected: PASS

- [ ] **Step 5: Wire `stop` into `sandbox-command.ts`**

Read `src/cli/sandbox-command.ts` lines 115–121 (the `down` subcommand block). Add a new `stop` branch immediately after it, and extend `runSandboxCommand`'s input type to accept the extra dependencies (`stateStore`, `sleep`, `logger`) needed only by `stop`:

```typescript
  if (subcommand === 'down') {
    await input.docker.down(input.config.sandbox.containerName);
    return;
  }

  if (subcommand === 'stop') {
    await runStopCommand({
      args: input.args.slice(1),
      stateStore: input.stateStore,
      docker: input.docker,
      containerName: input.config.sandbox.containerName,
      sleep: input.sleep,
      logger: input.logger,
    });
    return;
  }
```

Add the import at the top of the file:

```typescript
import { runStopCommand } from './stop-command.js';
```

Extend the `runSandboxCommand` input type (the `export async function runSandboxCommand(input: {` block) by adding these fields after `docker: DockerCli;`:

```typescript
  stateStore: { listRunRecords: () => Promise<import('../domain/types.js').RunRecord[]> };
  sleep: (ms: number) => Promise<void>;
  logger: { info: (message: string) => void };
```

- [ ] **Step 6: Add a `sandbox stop` test**

Add to `test/cli/sandbox-command.test.ts`, after the `'dispatches down to the configured container name'` test:

```typescript
  it('waits for active runs before stopping via sandbox stop', async () => {
    const docker = createDockerMock();
    let calls = 0;
    const listRunRecords = vi.fn(async () => {
      calls += 1;
      return calls < 2 ? [{ status: 'running' }] : [{ status: 'completed' }];
    });

    await runSandboxCommand({
      args: ['stop'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      stateStore: { listRunRecords } as never,
      sleep: vi.fn(async () => {}),
      logger: { info: () => {} },
    });

    expect(listRunRecords).toHaveBeenCalledTimes(2);
    expect(docker.down).toHaveBeenCalledWith('wake-sandbox', { timeoutSeconds: 60 });
  });
```

Every other call site of `runSandboxCommand` in this test file must now also pass `stateStore`, `sleep`, and `logger` (they're required fields on the input type). Add these three lines to every existing `runSandboxCommand({...})` call in the file:

```typescript
      stateStore: { listRunRecords: async () => [] },
      sleep: vi.fn(async () => {}),
      logger: { info: () => {} },
```

- [ ] **Step 7: Run test to verify it fails, then passes**

Run: `npx vitest run test/cli/sandbox-command.test.ts`
Expected first: FAIL (missing `stateStore`/`sleep`/`logger` in existing calls, or `runStopCommand` not wired). Fix wiring from Step 5 if needed, then re-run.
Expected after fix: PASS.

- [ ] **Step 8: Wire top-level `wake stop` and the new deps into `main.ts`**

In `src/main.ts`, the `runSandbox` closure (around line 380) currently builds `docker` and calls `runSandboxCommand` with `{ args: commandArgs, config, wakeRoot, containerHomeRoot, docker }`. Extend it to also build and pass `stateStore`, `sleep`, and `logger`:

```typescript
    runSandbox: async (commandArgs) => {
      const wakeRoot = resolve(
        readFlagBeforeCommandTerminator('--wake-root', commandArgs) ?? process.cwd(),
      );
      const stateStore = createStateStore({ wakeRoot });
      await stateStore.ensureWakeRoot();
      const config = await loadWakeConfig({
        wakeRoot,
        configFile: stateStore.paths.configFile,
      });
      const docker = createDockerCli({
        run: (dockerArgs) => runCommand('docker', dockerArgs),
        inspectImage: inspectDockerImage,
        inspectContainer: inspectDockerContainer,
      });

      await runSandboxCommand({
        args: commandArgs,
        config,
        wakeRoot,
        containerHomeRoot: stateStore.paths.containerHomeRoot,
        docker,
        stateStore,
        sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
        logger: {
          info(message) {
            console.log(message);
          },
        },
      });
    },
```

Add a top-level `stop` route in `dispatchMainCommand` (after the `sandbox` block, around line 354):

```typescript
  if (command === 'stop') {
    await input.runSandbox(['stop', ...input.args.slice(1)]);
    return;
  }
```

- [ ] **Step 9: Add a `main.test.ts` routing test**

Read `test/cli/main.test.ts` first to match its exact `dispatchMainCommand` test pattern (it stubs each `run*` function with a `vi.fn()` and asserts which one was called with which args). Add a test asserting that `dispatchMainCommand({ args: ['stop', '--timeout-ms', '5000'], ... })` calls `runSandbox` with `['stop', '--timeout-ms', '5000']`.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run test/cli/main.test.ts`
Expected: PASS

- [ ] **Step 11: Route `stop` to the host in the generated launchers**

In `src/cli/scaffold-assets.ts`, change the bash launcher's case statement (currently `'  init|sandbox)',`) to:

```typescript
    '  init|sandbox|stop)',
```

And the PowerShell switch: add a `"stop"` case identical in shape to the existing `"sandbox"` case, right after it:

```typescript
    '  "stop" {',
    '    & npx tsx $localMain @Args',
    '    exit $LASTEXITCODE',
    '  }',
```

- [ ] **Step 12: Add or update a scaffold-assets test**

Search for an existing test file: run `Glob` for `**/scaffold-assets.test.ts`. If one exists, add assertions that the generated `wake.sh` contains `init|sandbox|stop)` and `wake.ps1` contains a `"stop"` case. If none exists, create `test/cli/scaffold-assets.test.ts`:

```typescript
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scaffoldWakeHome } from '../../src/cli/scaffold-assets.js';

describe('scaffoldWakeHome launchers', () => {
  it('routes stop to the host in the bash and PowerShell launchers', async () => {
    const wakeRoot = await mkdtemp(resolve(tmpdir(), 'wake-scaffold-'));
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const shellLauncher = await readFile(resolve(wakeRoot, 'wake.sh'), 'utf8');
    const powerShellLauncher = await readFile(resolve(wakeRoot, 'wake.ps1'), 'utf8');

    expect(shellLauncher).toContain('init|sandbox|stop)');
    expect(powerShellLauncher).toContain('"stop" {');
  });
});
```

- [ ] **Step 13: Run test to verify it passes**

Run: `npx vitest run test/cli/scaffold-assets.test.ts`
Expected: PASS

- [ ] **Step 14: Update docs**

In `docs/development.md`, find the "Sandbox Setup" section documenting `wake sandbox down`. Add directly after it:

```markdown
- `./wake.sh stop` (or `wake sandbox stop`) — waits for any in-progress agent run to finish (polling `.wake/runs/*.json` for `status: "running"`), then stops the container with a 60s grace period. Use this instead of `wake sandbox down` when a run may be active. Flags: `--timeout-ms` (abort waiting after this long instead of blocking forever), `--poll-interval-ms`.
```

In `README.md`, find wherever `wake sandbox down` is mentioned in the sandbox walkthrough and add a one-line pointer to `wake stop` as the safe alternative when a run may be active.

- [ ] **Step 15: Full verify and commit**

Run: `npm run verify`
Expected: build succeeds, all tests pass.

```bash
git add src/cli/stop-command.ts src/cli/sandbox-command.ts src/main.ts src/cli/scaffold-assets.ts test/cli/stop-command.test.ts test/cli/sandbox-command.test.ts test/cli/main.test.ts test/cli/scaffold-assets.test.ts docs/development.md README.md
git commit -m "feat: wake stop waits for active runs before stopping the sandbox (#111)"
```

---

### Task 3: Self-update ledger and `sandbox.imageRepository` config field

**Files:**
- Create: `src/adapters/fs/self-update-ledger.ts`
- Test: `test/adapters/self-update-ledger.test.ts`
- Modify: `src/domain/schema.ts`
- Modify: `docs/configuration.md`

**Interfaces:**
- Produces: `readSelfUpdateLedger(path: string): Promise<SelfUpdateLedger>`, `writeSelfUpdateLedger(path: string, ledger: SelfUpdateLedger): Promise<void>`, and the type:
  ```typescript
  export type SelfUpdateLedger = {
    lastAppliedTag: string | null;
    lastKnownGoodTag: string | null;
    badTags: Array<{ tag: string; reason: string; recordedAt: string }>;
  };
  ```
- Consumed by Task 4 (`self-update-command.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/adapters/self-update-ledger.test.ts`:

```typescript
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readSelfUpdateLedger,
  writeSelfUpdateLedger,
} from '../../src/adapters/fs/self-update-ledger.js';

describe('self-update ledger', () => {
  it('returns an empty ledger when no file exists yet', async () => {
    const wakeRoot = await mkdtemp(resolve(tmpdir(), 'wake-ledger-'));
    const ledgerPath = resolve(wakeRoot, 'self-update-ledger.json');

    const ledger = await readSelfUpdateLedger(ledgerPath);

    expect(ledger).toEqual({ lastAppliedTag: null, lastKnownGoodTag: null, badTags: [] });
  });

  it('round-trips a written ledger', async () => {
    const wakeRoot = await mkdtemp(resolve(tmpdir(), 'wake-ledger-'));
    const ledgerPath = resolve(wakeRoot, 'self-update-ledger.json');

    await writeSelfUpdateLedger(ledgerPath, {
      lastAppliedTag: 'v0.0.80',
      lastKnownGoodTag: 'v0.0.79',
      badTags: [{ tag: 'v0.0.80', reason: 'health check failed', recordedAt: '2026-07-11T00:00:00.000Z' }],
    });

    const ledger = await readSelfUpdateLedger(ledgerPath);

    expect(ledger.lastAppliedTag).toBe('v0.0.80');
    expect(ledger.lastKnownGoodTag).toBe('v0.0.79');
    expect(ledger.badTags).toHaveLength(1);
    expect(ledger.badTags[0]?.tag).toBe('v0.0.80');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/self-update-ledger.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the ledger module**

Create `src/adapters/fs/self-update-ledger.ts`:

```typescript
import { readJsonFile, writeJsonFile } from '../../lib/json-file.js';

export type SelfUpdateLedger = {
  lastAppliedTag: string | null;
  lastKnownGoodTag: string | null;
  badTags: Array<{ tag: string; reason: string; recordedAt: string }>;
};

const EMPTY_LEDGER: SelfUpdateLedger = {
  lastAppliedTag: null,
  lastKnownGoodTag: null,
  badTags: [],
};

export async function readSelfUpdateLedger(path: string): Promise<SelfUpdateLedger> {
  try {
    return await readJsonFile<SelfUpdateLedger>(path);
  } catch {
    return EMPTY_LEDGER;
  }
}

export async function writeSelfUpdateLedger(
  path: string,
  ledger: SelfUpdateLedger,
): Promise<void> {
  await writeJsonFile(path, ledger);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/self-update-ledger.test.ts`
Expected: PASS

- [ ] **Step 5: Add `sandbox.imageRepository` to the config schema**

In `src/domain/schema.ts`, in the `sandbox: z.object({...})` block (line 314), add a new field after `image`:

```typescript
  sandbox: z.object({
    image: z.string().min(1).default('wake-sandbox'),
    // Base image name (no tag) that `wake sandbox self-update` appends a
    // release tag to, e.g. "wake-sandbox:v0.0.80". `image` above stays the
    // resolved ref that `build`/`up`/`update` actually run.
    imageRepository: z.string().min(1).default('wake-sandbox'),
    containerName: z.string().min(1).default('wake-sandbox'),
```

Update the trailing `.default({...})` fallback object on the same block (currently `.default({ image: 'wake-sandbox', containerName: 'wake-sandbox', ... })`) to include `imageRepository: 'wake-sandbox'`:

```typescript
  }).default({ image: 'wake-sandbox', imageRepository: 'wake-sandbox', containerName: 'wake-sandbox', containerMountPath: '/wake', containerHomeMountPath: '/home/wake', extraMounts: [] }),
```

- [ ] **Step 6: Update `docs/configuration.md`**

Find the `sandbox` field documentation block (reported at lines 119–129) and add a row/line for `imageRepository`, describing it as the base image name self-update tags per release.

- [ ] **Step 7: Run full test suite and build**

Run: `npm run build && npx vitest run`
Expected: PASS — confirm no other test hardcodes the sandbox config object shape in a way that breaks (e.g. `test/cli/sandbox-command.test.ts` uses `createDefaultWakeConfig`, which will pick up the new field automatically since it flows through zod defaults).

- [ ] **Step 8: Commit**

```bash
git add src/adapters/fs/self-update-ledger.ts test/adapters/self-update-ledger.test.ts src/domain/schema.ts docs/configuration.md
git commit -m "feat: add self-update ledger and sandbox.imageRepository config field"
```

---

### Task 4: Self-update orchestration (`wake sandbox self-update`)

**Files:**
- Create: `src/cli/self-update-command.ts`
- Test: `test/cli/self-update-command.test.ts`
- Modify: `src/cli/sandbox-command.ts`
- Modify: `src/main.ts`
- Modify: `package.json`
- Modify: `docs/development.md`, `README.md`
- Delete: `scripts/watch-main-update.ps1`

**Interfaces:**
- Consumes: `waitForActiveRuns` (Task 2), `readSelfUpdateLedger`/`writeSelfUpdateLedger`/`SelfUpdateLedger` (Task 3), `DockerCli.build`/`update`/`exec` (Task 1 + existing).
- Produces: `runSelfUpdateCommand(input): Promise<void>` from `src/cli/self-update-command.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli/self-update-command.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { runSelfUpdateCommand } from '../../src/cli/self-update-command.js';
import type { SelfUpdateLedger } from '../../src/adapters/fs/self-update-ledger.js';

function baseDeps(overrides: Partial<Parameters<typeof runSelfUpdateCommand>[0]> = {}) {
  const ledger: SelfUpdateLedger = { lastAppliedTag: 'v0.0.79', lastKnownGoodTag: 'v0.0.79', badTags: [] };

  return {
    args: [],
    repoRoot: '/repo/wake',
    imageRepository: 'wake-sandbox',
    containerName: 'wake-sandbox',
    stateStore: { listRunRecords: async () => [] },
    docker: {
      build: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      exec: vi.fn(async () => {}),
    },
    git: {
      latestTag: vi.fn(async () => 'v0.0.80'),
      isWorkingTreeClean: vi.fn(async () => true),
      checkoutTag: vi.fn(async () => {}),
    },
    issueReporter: { createIssue: vi.fn(async () => {}) },
    readLedger: vi.fn(async () => ledger),
    writeLedger: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    logger: { info: () => {}, error: () => {} },
    ...overrides,
  };
}

describe('runSelfUpdateCommand', () => {
  it('does nothing when the latest tag matches the last applied tag', async () => {
    const deps = baseDeps({ git: { latestTag: vi.fn(async () => 'v0.0.79'), isWorkingTreeClean: vi.fn(async () => true), checkoutTag: vi.fn(async () => {}) } });

    await runSelfUpdateCommand(deps as never);

    expect(deps.docker.build).not.toHaveBeenCalled();
  });

  it('skips a tag already recorded as bad, unless --force is passed', async () => {
    const ledger: SelfUpdateLedger = {
      lastAppliedTag: 'v0.0.79',
      lastKnownGoodTag: 'v0.0.79',
      badTags: [{ tag: 'v0.0.80', reason: 'boom', recordedAt: '2026-07-11T00:00:00.000Z' }],
    };
    const deps = baseDeps({ readLedger: vi.fn(async () => ledger) });

    await runSelfUpdateCommand(deps as never);

    expect(deps.docker.build).not.toHaveBeenCalled();
  });

  it('builds, updates, health-checks, and records success on a new tag', async () => {
    const deps = baseDeps();

    await runSelfUpdateCommand(deps as never);

    expect(deps.git.checkoutTag).toHaveBeenCalledWith('v0.0.80');
    expect(deps.docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(deps.docker.update).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(deps.docker.exec).toHaveBeenCalledWith(
      'wake-sandbox',
      ['node', '/app/dist/src/main.js', 'tick', '--wake-root', '/tmp/wake-self-update-healthcheck'],
    );
    expect(deps.writeLedger).toHaveBeenCalledWith(
      expect.objectContaining({ lastAppliedTag: 'v0.0.80', lastKnownGoodTag: 'v0.0.80' }),
    );
    expect(deps.issueReporter.createIssue).not.toHaveBeenCalled();
  });

  it('rolls back and files an issue when the health check fails', async () => {
    const deps = baseDeps({
      docker: {
        build: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        exec: vi.fn(async () => {
          throw new Error('tick exited 1');
        }),
      },
    });

    await runSelfUpdateCommand(deps as never);

    expect(deps.docker.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(deps.docker.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ image: 'wake-sandbox:v0.0.79' }),
    );
    expect(deps.writeLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        lastAppliedTag: 'v0.0.79',
        lastKnownGoodTag: 'v0.0.79',
        badTags: [expect.objectContaining({ tag: 'v0.0.80' })],
      }),
    );
    expect(deps.issueReporter.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('v0.0.80'),
        body: expect.stringContaining('tick exited 1'),
      }),
    );
  });

  it('refuses to proceed when the working tree is dirty', async () => {
    const deps = baseDeps({
      git: {
        latestTag: vi.fn(async () => 'v0.0.80'),
        isWorkingTreeClean: vi.fn(async () => false),
        checkoutTag: vi.fn(async () => {}),
      },
    });

    await expect(runSelfUpdateCommand(deps as never)).rejects.toThrow('working tree has local changes');
    expect(deps.docker.build).not.toHaveBeenCalled();
  });

  it('supports --tag to target an explicit tag regardless of git state', async () => {
    const deps = baseDeps({
      args: ['--tag', 'v0.0.81', '--force'],
      git: {
        latestTag: vi.fn(async () => 'v0.0.79'),
        isWorkingTreeClean: vi.fn(async () => true),
        checkoutTag: vi.fn(async () => {}),
      },
    });

    await runSelfUpdateCommand(deps as never);

    expect(deps.git.checkoutTag).toHaveBeenCalledWith('v0.0.81');
    expect(deps.docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.81' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/self-update-command.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `self-update-command.ts`**

Create `src/cli/self-update-command.ts`:

```typescript
import { waitForActiveRuns } from './stop-command.js';
import type { SelfUpdateLedger } from '../adapters/fs/self-update-ledger.js';
import type { RunRecord } from '../domain/types.js';

const HEALTHCHECK_WAKE_ROOT = '/tmp/wake-self-update-healthcheck';

function readFlag(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function hasFlag(name: string, args: string[]): boolean {
  return args.includes(name);
}

export async function runSelfUpdateCommand(input: {
  args: string[];
  repoRoot: string;
  imageRepository: string;
  containerName: string;
  stateStore: { listRunRecords: () => Promise<RunRecord[]> };
  docker: {
    build: (options: { image: string; dockerfile: string; contextDir: string }) => Promise<void>;
    update: (options: { image: string; containerName: string; wakeRoot: string; containerHomeRoot: string; containerMountPath: string; containerHomeMountPath: string }) => Promise<void>;
    exec: (containerName: string, command: string[]) => Promise<void>;
  };
  git: {
    latestTag: () => Promise<string>;
    isWorkingTreeClean: () => Promise<boolean>;
    checkoutTag: (tag: string) => Promise<void>;
  };
  issueReporter: { createIssue: (input: { title: string; body: string }) => Promise<void> };
  readLedger: () => Promise<SelfUpdateLedger>;
  writeLedger: (ledger: SelfUpdateLedger) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  logger: { info: (message: string) => void; error: (message: string) => void };
  wakeRoot: string;
  containerHomeRoot: string;
  containerMountPath: string;
  containerHomeMountPath: string;
  dockerfilePath: string;
}): Promise<void> {
  const force = hasFlag('--force', input.args);
  const explicitTag = readFlag('--tag', input.args);
  const ledger = await input.readLedger();

  const tag = explicitTag ?? (await input.git.latestTag());

  if (!force && tag === ledger.lastAppliedTag) {
    input.logger.info(`[self-update] already on ${tag}; nothing to do`);
    return;
  }

  if (!force && ledger.badTags.some((bad) => bad.tag === tag)) {
    input.logger.info(`[self-update] ${tag} is recorded as a bad tag; skipping (use --force to retry)`);
    return;
  }

  if (!(await input.git.isWorkingTreeClean())) {
    throw new Error(`[self-update] repo working tree has local changes; refusing to update to ${tag}`);
  }

  await waitForActiveRuns({
    listRunRecords: input.stateStore.listRunRecords,
    sleep: input.sleep,
    logger: input.logger,
  });

  const newImage = `${input.imageRepository}:${tag}`;
  const updateInput = {
    containerName: input.containerName,
    wakeRoot: input.wakeRoot,
    containerHomeRoot: input.containerHomeRoot,
    containerMountPath: input.containerMountPath,
    containerHomeMountPath: input.containerHomeMountPath,
  };

  try {
    await input.git.checkoutTag(tag);
    await input.docker.build({
      image: newImage,
      dockerfile: input.dockerfilePath,
      contextDir: input.repoRoot,
    });
    await input.docker.update({ ...updateInput, image: newImage });
    await input.docker.exec(input.containerName, [
      'node',
      '/app/dist/src/main.js',
      'tick',
      '--wake-root',
      HEALTHCHECK_WAKE_ROOT,
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.logger.error(`[self-update] rollout of ${tag} failed: ${reason}`);

    if (ledger.lastKnownGoodTag !== null) {
      const rollbackImage = `${input.imageRepository}:${ledger.lastKnownGoodTag}`;
      await input.git.checkoutTag(ledger.lastKnownGoodTag);
      await input.docker.update({ ...updateInput, image: rollbackImage });
      input.logger.info(`[self-update] rolled back to ${ledger.lastKnownGoodTag}`);
    } else {
      input.logger.error('[self-update] no previous known-good tag to roll back to');
    }

    await input.writeLedger({
      lastAppliedTag: ledger.lastKnownGoodTag,
      lastKnownGoodTag: ledger.lastKnownGoodTag,
      badTags: [
        ...ledger.badTags,
        { tag, reason, recordedAt: new Date().toISOString() },
      ],
    });

    await input.issueReporter.createIssue({
      title: `Self-update to ${tag} failed and was rolled back`,
      body: [
        `Automated update to \`${tag}\` failed during rollout and was rolled back to \`${ledger.lastKnownGoodTag ?? 'unknown'}\`.`,
        '',
        '```',
        reason,
        '```',
      ].join('\n'),
    });

    return;
  }

  await input.writeLedger({
    lastAppliedTag: tag,
    lastKnownGoodTag: tag,
    badTags: ledger.badTags,
  });
  input.logger.info(`[self-update] ${tag} is live and healthy`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/self-update-command.test.ts`
Expected: PASS. If the rollback test fails because `docker.update` rollback call omits `stopTimeoutSeconds`, that's fine — the test only asserts `image`; don't over-fit.

- [ ] **Step 5: Wire `self-update` into `sandbox-command.ts`**

Add a `git` helper module inline in `sandbox-command.ts` is out of scope — instead, extend `runSandboxCommand`'s input with the same shape `runSelfUpdateCommand` needs, and add a `self-update` branch. Add near the `stop` branch from Task 2:

```typescript
  if (subcommand === 'self-update') {
    const repoRoot = input.config.dev?.repoRoot;
    if (repoRoot === undefined || repoRoot.length === 0) {
      throw new Error('Sandbox self-update requires config.dev.repoRoot');
    }
    if (input.selfUpdate === undefined) {
      throw new Error('Sandbox self-update requires git/issueReporter/ledger dependencies');
    }

    await runSelfUpdateCommand({
      args: input.args.slice(1),
      repoRoot,
      imageRepository: input.config.sandbox.imageRepository,
      containerName: input.config.sandbox.containerName,
      stateStore: input.stateStore,
      docker: input.docker,
      git: input.selfUpdate.git,
      issueReporter: input.selfUpdate.issueReporter,
      readLedger: input.selfUpdate.readLedger,
      writeLedger: input.selfUpdate.writeLedger,
      sleep: input.sleep,
      logger: input.logger,
      wakeRoot: input.wakeRoot,
      containerHomeRoot: input.containerHomeRoot,
      containerMountPath: input.config.sandbox.containerMountPath,
      containerHomeMountPath: input.config.sandbox.containerHomeMountPath,
      dockerfilePath: resolve(repoRoot, 'docker', 'Dockerfile'),
    });
    return;
  }
```

Add the import and extend the `runSandboxCommand` input type with an optional `selfUpdate` field (optional because only the `self-update` subcommand needs it, keeping every other existing call site/test in Task 2 unaffected):

```typescript
import { runSelfUpdateCommand } from './self-update-command.js';
```

```typescript
  selfUpdate?: {
    git: {
      latestTag: () => Promise<string>;
      isWorkingTreeClean: () => Promise<boolean>;
      checkoutTag: (tag: string) => Promise<void>;
    };
    issueReporter: { createIssue: (input: { title: string; body: string }) => Promise<void> };
    readLedger: () => Promise<import('../adapters/fs/self-update-ledger.js').SelfUpdateLedger>;
    writeLedger: (ledger: import('../adapters/fs/self-update-ledger.js').SelfUpdateLedger) => Promise<void>;
  };
```

- [ ] **Step 6: Write a `sandbox-command.test.ts` test for the `self-update` dispatch**

Add to `test/cli/sandbox-command.test.ts`:

```typescript
  it('dispatches self-update with git, ledger, and issue-reporter deps', async () => {
    const docker = createDockerMock();
    const config = { ...createDefaultWakeConfig(wakeRoot), dev: { repoRoot } };
    const checkoutTag = vi.fn(async () => {});
    const createIssue = vi.fn(async () => {});
    const writeLedger = vi.fn(async () => {});

    await runSandboxCommand({
      args: ['self-update', '--tag', 'v0.0.80', '--force'],
      config,
      wakeRoot,
      containerHomeRoot,
      docker,
      stateStore: { listRunRecords: async () => [] } as never,
      sleep: vi.fn(async () => {}),
      logger: { info: () => {} },
      selfUpdate: {
        git: {
          latestTag: vi.fn(async () => 'v0.0.79'),
          isWorkingTreeClean: vi.fn(async () => true),
          checkoutTag,
        },
        issueReporter: { createIssue },
        readLedger: vi.fn(async () => ({ lastAppliedTag: 'v0.0.79', lastKnownGoodTag: 'v0.0.79', badTags: [] })),
        writeLedger,
      },
    });

    expect(checkoutTag).toHaveBeenCalledWith('v0.0.80');
    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(writeLedger).toHaveBeenCalledWith(
      expect.objectContaining({ lastAppliedTag: 'v0.0.80' }),
    );
  });
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/cli/sandbox-command.test.ts`
Expected: PASS

- [ ] **Step 8: Wire real `git`/`gh` adapters and the ledger path in `main.ts`**

In `src/main.ts`, inside the `runSandbox` closure from Task 2 Step 8, add the concrete `selfUpdate` deps only when the subcommand is `self-update` (avoid shelling out to `git`/`gh` for every other sandbox subcommand). Add after the `docker` construction and before the `runSandboxCommand` call:

```typescript
      const selfUpdate = commandArgs[0] === 'self-update'
        ? {
            git: {
              latestTag: async () => {
                await runCommand('git', ['-C', config.dev?.repoRoot ?? process.cwd(), 'fetch', '--tags']);
                const output = await runCommandCapture('git', [
                  '-C',
                  config.dev?.repoRoot ?? process.cwd(),
                  'tag',
                  '--list',
                  'v*',
                  '--sort=-v:refname',
                ]);
                const [latest] = output.split('\n').filter((line) => line.trim().length > 0);
                if (latest === undefined) {
                  throw new Error('No version tags found in repo');
                }
                return latest.trim();
              },
              isWorkingTreeClean: async () => {
                const output = await runCommandCapture('git', [
                  '-C',
                  config.dev?.repoRoot ?? process.cwd(),
                  'status',
                  '--porcelain',
                ]);
                return output.trim().length === 0;
              },
              checkoutTag: async (tag: string) => {
                await runCommand('git', ['-C', config.dev?.repoRoot ?? process.cwd(), 'checkout', tag]);
              },
            },
            issueReporter: {
              createIssue: async (issue: { title: string; body: string }) => {
                await runCommand('gh', [
                  'issue',
                  'create',
                  '--repo',
                  'atolis-hq/wake',
                  '--title',
                  issue.title,
                  '--body',
                  issue.body,
                ]);
              },
            },
            readLedger: () => readSelfUpdateLedger(resolve(wakeRoot, 'self-update-ledger.json')),
            writeLedger: (ledger: SelfUpdateLedger) =>
              writeSelfUpdateLedger(resolve(wakeRoot, 'self-update-ledger.json'), ledger),
          }
        : undefined;

      await runSandboxCommand({
        args: commandArgs,
        config,
        wakeRoot,
        containerHomeRoot: stateStore.paths.containerHomeRoot,
        docker,
        stateStore,
        sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
        logger: {
          info(message) {
            console.log(message);
          },
          error(message) {
            console.error(message);
          },
        },
        selfUpdate,
      });
```

Add a `runCommandCapture` helper next to `runCommand` in `src/main.ts` (after the existing `runCommand` function):

```typescript
async function runCommandCapture(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolveRun(stdout);
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode ?? 1}`));
    });
  });
}
```

Add the two new imports at the top of `src/main.ts`:

```typescript
import {
  readSelfUpdateLedger,
  writeSelfUpdateLedger,
  type SelfUpdateLedger,
} from './adapters/fs/self-update-ledger.js';
```

Also update `runSandboxCommand`'s `logger` type (Task 2, Step 5's added field) to include the optional `error` method it's now called with, so `error(message)` type-checks: change `logger: { info: (message: string) => void };` to `logger: { info: (message: string) => void; error?: (message: string) => void };` in `sandbox-command.ts`'s input type, and in `self-update-command.ts`'s `logger` field usage pass `input.logger.error?.(...)`.

- [ ] **Step 9: Build to catch type errors**

Run: `npm run build`
Expected: PASS. Fix any type mismatches surfaced (this step wires several previously-separate pieces together; expect to iterate here).

- [ ] **Step 10: Add npm script**

In `package.json`, add after `"smoke:cursor"`:

```json
    "self-update": "tsx src/main.ts sandbox self-update",
```

- [ ] **Step 11: Delete the dead watcher script**

Delete `scripts/watch-main-update.ps1` (references `update.ps1`/`update.sh` files that never existed in this repo).

- [ ] **Step 12: Document the command**

In `docs/development.md`, add a new subsection after the `wake stop` docs added in Task 2:

```markdown
### Self-update

`wake sandbox self-update` (or `npm run self-update`) checks for a newer version tag on `origin`, and if found: waits for any active run to finish (same mechanism as `wake stop`), checks out the tag, builds a versioned image (`<sandbox.imageRepository>:<tag>`), replaces the running container, and health-checks it with a real `tick` against a throwaway `--wake-root`. On failure it rolls back to the last-known-good image/tag, records the failed tag in `<wake-root>/self-update-ledger.json` so it's never silently retried, and files a GitHub issue with the failure detail via `gh issue create`.

Flags:
- `--force` — proceed even if the tag matches what's already applied, or is recorded as a known-bad tag.
- `--tag <tag>` — target an explicit tag instead of discovering the latest one (useful for testing/rehearsal).

Requires a clean git working tree in `config.dev.repoRoot` and `gh` authenticated with permission to create issues on the repo.
```

Add a one-line pointer in `README.md`'s sandbox section referencing `wake sandbox self-update` as the unattended-deploy path, cross-referencing `docs/development.md`.

- [ ] **Step 13: Full verify**

Run: `npm run verify`
Expected: build + all tests pass.

- [ ] **Step 14: Commit**

```bash
git add src/cli/self-update-command.ts src/cli/sandbox-command.ts src/main.ts test/cli/self-update-command.test.ts test/cli/sandbox-command.test.ts package.json docs/development.md README.md
git rm scripts/watch-main-update.ps1
git commit -m "feat: add wake sandbox self-update with rollback and issue-filing on failure"
```

---

### Task 5: Isolated live rehearsal (manual, not committed as a test)

**Files:** none created — this is a manual verification pass against real Docker, using an isolated container/image/wake-root so the live `wake-sandbox` container from this session's earlier `docker ps` check is never touched.

**Interfaces:**
- Consumes: the built `dist/src/main.js` from Task 4, real `docker`/`git`/`gh` CLIs.

- [ ] **Step 1: Build**

Run: `npm run build`

- [ ] **Step 2: Set up an isolated scratch environment**

Create a scratch wake home and a throwaway git worktree at a fixed tag, so `self-update`'s `git checkout` doesn't touch the real working tree of `C:\git\atolis-hq\wake` mid-session:

```bash
mkdir -p /tmp/wake-selfupdate-rehearsal
cd /path/to/wake && git worktree add /tmp/wake-selfupdate-rehearsal-repo v0.0.79
```

Use `npx tsx src/main.ts init /tmp/wake-selfupdate-rehearsal --repo-root /tmp/wake-selfupdate-rehearsal-repo` (check `init-command.ts`'s actual flag name for repo root override first — read the file if `--repo-root` isn't it) to scaffold an isolated wake-root. Edit the scaffolded `config.json`: set `sandbox.containerName` to `wake-sandbox-rehearsal` and `sandbox.imageRepository`/`sandbox.image` to `wake-sandbox-rehearsal`.

- [ ] **Step 3: Rehearse a successful update**

From the scratch wake-root, run `wake sandbox build`, then `wake sandbox up`, to get a baseline `v0.0.79` container running under the rehearsal name. Seed the ledger by writing `self-update-ledger.json` with `lastAppliedTag`/`lastKnownGoodTag` set to `v0.0.79`. Then run:

```bash
./wake.sh sandbox self-update --tag v0.0.80 --force
```

(or whatever the actual next tag is — use `--tag` to simulate a new release without waiting for one). Confirm: the rehearsal container is replaced, `docker ps` shows it running under the new image tag, and `self-update-ledger.json` now shows `lastAppliedTag: v0.0.80`.

- [ ] **Step 4: Rehearse a failed update and rollback**

Temporarily break the health check by pointing at a tag whose build is fine but whose container fails the `tick` health check — simplest: pass `--tag` at a commit where `dist/src/main.js tick` would throw (e.g. temporarily rename `dist/src/main.js` inside the built image is impractical; instead, temporarily edit `docker/Dockerfile` in the rehearsal worktree to `RUN echo 'process.exit(1)' >> dist/src/main.js` before building, or simpler: temporarily set the rehearsal config's fixture path to an invalid location so tick throws). Run `self-update --force` again and confirm: `docker.update` is called twice (new image, then rollback image), the container ends up back on the last-known-good tag, `self-update-ledger.json` records the bad tag, and `gh issue list --repo atolis-hq/wake` shows the new issue was filed. Close/delete that test issue afterward if the repo doesn't want rehearsal noise — check with a `gh issue close` if appropriate, or leave it if the operator is fine with it (state which you did).

- [ ] **Step 5: Tear down the rehearsal environment**

```bash
docker stop wake-sandbox-rehearsal && docker rm wake-sandbox-rehearsal
docker rmi wake-sandbox-rehearsal:v0.0.79 wake-sandbox-rehearsal:v0.0.80
cd /path/to/wake && git worktree remove /tmp/wake-selfupdate-rehearsal-repo --force
rm -rf /tmp/wake-selfupdate-rehearsal
```

- [ ] **Step 6: Report results**

Summarize what was rehearsed (success path + rollback path), whether a real GitHub issue was filed and its number/URL, and confirm the live `wake-sandbox` container (checked at session start) was never touched (`docker ps` still shows its original start time).

---

## Self-Review Notes

- **Spec coverage:** #111 (safe stop, waits for active runs) → Task 2. Roadmap 2.6 (poll tags, safe-stop, build+update with versioning, health-check, rollback + never-retry ledger, file GitHub issue) → Tasks 3–4. "Try it yourself" / "simulate the new tag ... or force flag" → Task 5, `--force` and `--tag` flags in Task 4.
- **Docker image versioning gap** (identified during research: `sandbox.image` was a fixed tag with no rollback target) is closed by `sandbox.imageRepository` (Task 3) — old image tags are never pruned, so rollback via `docker.update` needs no rebuild.
- **#111's own in-flight GitHub implementation plan** (comment on the issue, unapproved) is superseded by this plan; once this lands, close #111 referencing the PR rather than leaving it for Wake's own loop to pick up separately.
