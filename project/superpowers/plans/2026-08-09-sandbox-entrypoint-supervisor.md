# Sandbox Entrypoint Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the target (`src-next`) source-mode sandbox container survive a
crashing `wake start` (e.g. missing GitHub auth on first boot) instead of
exiting, so `wake sandbox setup` can always reach a live container through
`docker exec`.

**Architecture:** Port the legacy `wake sandbox-entrypoint` supervisor
pattern (`src/cli/sandbox-entrypoint-command.ts`) into `src-next` as a real
CLI command: a detached, retried `wake start` child process supervised by a
PID-1 process that itself never exits. Wire it into the CLI command surface
(`surfaces/cli/main.ts`), compose real dependencies in `bootstrap`
(`surface-cli-applications.ts`), and point the source-mode Dockerfile
template (`bootstrap/initialise.ts`) at it instead of its current raw
one-shot `sh -c "... exec node ... start"` line, which dies the moment
`wake start` throws.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs/promises`, Vitest.

## Global Constraints

- Follow `src-next`'s domain-seam rules from `CLAUDE.md`: no magic strings for
  closed vocabulary, no adapter leakage into `surfaces`, `bootstrap` is the
  only place that selects concrete `node:child_process`/`fs` calls.
- Before treating the task complete, run `npm run lint:contracts`,
  `npm run lint:architecture`, `npm run knip:next`, and `npm run verify:next`
  (per `CLAUDE.md`), plus `npm run verify` since the legacy replacement gate
  (Task 28) hasn't landed yet.
- Reference docs describe only current behaviour — no "used to work like
  this" prose.
- This container/process never exits by design once running: any dependency
  that can throw inside the supervised retry loop must be caught and logged,
  never left to become an unhandled rejection (Node 24 terminates a process
  on an unhandled rejection by default, which would silently reintroduce the
  exact bug this plan fixes).

---

### Task 1: Pure sandbox-entrypoint supervisor logic

**Files:**
- Create: `src-next/surfaces/cli/commands/sandbox-entrypoint.ts`
- Test: `test-next/unit/surfaces/sandbox-entrypoint.test.ts`

**Interfaces:**
- Produces: `ResidentSupervisorDependencies`, `runResidentSupervisor(deps): Promise<never>`, `SandboxEntrypointDependencies`, `runSandboxEntrypoint(deps): Promise<void>` — all exported from `src-next/surfaces/cli/commands/sandbox-entrypoint.ts`. Task 2 and Task 3 both import these.

- [ ] **Step 1: Write the failing unit tests**

Create `test-next/unit/surfaces/sandbox-entrypoint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  runResidentSupervisor,
  runSandboxEntrypoint,
  type ResidentSupervisorDependencies,
  type SandboxEntrypointDependencies,
} from '../../../src-next/surfaces/cli/commands/sandbox-entrypoint.js';

describe('resident supervisor', () => {
  it('spawns wake start detached, records its pid, and restarts it after it exits', async () => {
    const events: string[] = [];
    let cycle = 0;
    const deps: ResidentSupervisorDependencies = {
      restartDelaySeconds: 5,
      wakeInvocation: ['node', '/app/dist-next/src-next/main.js'],
      pidFile: '/wake/.wake/logs/start.pid',
      startLogFile: '/wake/.wake/logs/start.log',
      spawnDetached: (command, arguments_, options) => {
        cycle += 1;
        events.push(`spawn:${command} ${arguments_.join(' ')} log=${options.logFile}`);
        return { pid: 1000 + cycle };
      },
      waitForExit: async (pid) => {
        events.push(`exit-wait:${pid}`);
        return 1;
      },
      writeFile: async (path, content) => {
        events.push(`write:${path}=${content}`);
      },
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
        if (cycle >= 2) throw new Error('test-stop');
      },
      log: (message) => events.push(`log:${message}`),
    };

    await expect(runResidentSupervisor(deps)).rejects.toThrow('test-stop');

    expect(events).toEqual([
      'log:wake start: starting resident loop',
      'spawn:node /app/dist-next/src-next/main.js start --wake-root /wake --no-sandbox log=/wake/.wake/logs/start.log',
      'write:/wake/.wake/logs/start.pid=1001',
      'exit-wait:1001',
      'log:wake start: resident loop exited with status 1; restarting in 5s',
      'sleep:5000',
      'log:wake start: starting resident loop',
      'spawn:node /app/dist-next/src-next/main.js start --wake-root /wake --no-sandbox log=/wake/.wake/logs/start.log',
      'write:/wake/.wake/logs/start.pid=1002',
      'exit-wait:1002',
      'log:wake start: resident loop exited with status 1; restarting in 5s',
      'sleep:5000',
    ]);
  });
});

describe('sandbox entrypoint', () => {
  function baseDeps(
    overrides: Partial<SandboxEntrypointDependencies>,
  ): SandboxEntrypointDependencies {
    return {
      startEnabled: false,
      restartDelaySeconds: 10,
      wakeInvocation: ['wake'],
      pidFile: '/wake/.wake/logs/start.pid',
      startLogFile: '/wake/.wake/logs/start.log',
      ensureLogDirectory: async () => {},
      spawnDetached: () => {
        throw new Error('spawnDetached must not be called when start is disabled');
      },
      waitForExit: async () => 0,
      writeFile: async () => {},
      sleep: async () => {},
      waitForever: async () => undefined as never,
      log: () => {},
      ...overrides,
    };
  }

  it('never starts wake start and still waits forever when start is disabled', async () => {
    const events: string[] = [];
    await runSandboxEntrypoint(
      baseDeps({
        ensureLogDirectory: async () => events.push('ensure-dir'),
        waitForever: async () => {
          events.push('wait-forever');
          return undefined as never;
        },
      }),
    );
    expect(events).toEqual(['ensure-dir', 'wait-forever']);
  });

  it('starts supervising wake start before waiting forever when start is enabled', async () => {
    const events: string[] = [];
    await runSandboxEntrypoint(
      baseDeps({
        startEnabled: true,
        wakeInvocation: ['wake'],
        ensureLogDirectory: async () => events.push('ensure-dir'),
        spawnDetached: (command, arguments_) => {
          events.push(`spawn:${command} ${arguments_.join(' ')}`);
          return { pid: 999 };
        },
        waitForExit: () => new Promise(() => {}),
        waitForever: async () => {
          events.push('wait-forever');
          return undefined as never;
        },
      }),
    );
    expect(events).toEqual([
      'ensure-dir',
      'spawn:wake start --wake-root /wake --no-sandbox',
      'wait-forever',
    ]);
  });

  it('resolves instead of crashing if the resident supervisor throws unexpectedly', async () => {
    await expect(
      runSandboxEntrypoint(
        baseDeps({
          startEnabled: true,
          spawnDetached: () => {
            throw new Error('spawn failed');
          },
          waitForever: async () => undefined as never,
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test-next/unit/surfaces/sandbox-entrypoint.test.ts`
Expected: FAIL — `src-next/surfaces/cli/commands/sandbox-entrypoint.ts` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src-next/surfaces/cli/commands/sandbox-entrypoint.ts`:

```ts
export interface ResidentSupervisorDependencies {
  readonly restartDelaySeconds: number;
  readonly wakeInvocation: readonly string[];
  readonly pidFile: string;
  readonly startLogFile: string;
  readonly spawnDetached: (
    command: string,
    arguments_: readonly string[],
    options: { readonly logFile: string },
  ) => { readonly pid: number };
  readonly waitForExit: (pid: number) => Promise<number>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface SandboxEntrypointDependencies extends ResidentSupervisorDependencies {
  readonly startEnabled: boolean;
  readonly ensureLogDirectory: () => Promise<void>;
  readonly waitForever: () => Promise<never>;
}

/**
 * Restarts `wake start` on every exit — a first-boot crash (e.g. missing
 * sandbox auth) must not stop the retry loop, since the operator's only path
 * to fixing it (`wake sandbox setup`) also depends on this loop's container
 * staying alive.
 */
export async function runResidentSupervisor(
  deps: ResidentSupervisorDependencies,
): Promise<never> {
  const [command, ...prefix] = deps.wakeInvocation;
  if (command === undefined) throw new Error('sandbox entrypoint requires a wake invocation');
  for (;;) {
    deps.log('wake start: starting resident loop');
    const { pid } = deps.spawnDetached(
      command,
      [...prefix, 'start', '--wake-root', '/wake', '--no-sandbox'],
      { logFile: deps.startLogFile },
    );
    await deps.writeFile(deps.pidFile, String(pid));
    const exitCode = await deps.waitForExit(pid);
    deps.log(
      `wake start: resident loop exited with status ${exitCode}; restarting in ${deps.restartDelaySeconds}s`,
    );
    await deps.sleep(deps.restartDelaySeconds * 1000);
  }
}

/**
 * Keeps the sandbox container alive regardless of whether `wake start` can
 * currently run — `sandbox setup`/`sandbox exec` need a live container to
 * reach into, including on first boot before auth is configured.
 */
export async function runSandboxEntrypoint(deps: SandboxEntrypointDependencies): Promise<void> {
  await deps.ensureLogDirectory();
  if (deps.startEnabled) {
    void runResidentSupervisor(deps).catch((error) => {
      deps.log(
        `wake start: supervisor stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  await deps.waitForever();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test-next/unit/surfaces/sandbox-entrypoint.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src-next/surfaces/cli/commands/sandbox-entrypoint.ts test-next/unit/surfaces/sandbox-entrypoint.test.ts
git commit -m "feat(surfaces): add sandbox-entrypoint supervisor logic"
```

---

### Task 2: Wire `sandbox-entrypoint` into the parsed CLI command surface

**Files:**
- Modify: `src-next/surfaces/cli/main.ts`
- Modify: `src-next/surfaces/cli/usage.ts`
- Modify: `test-next/integration/surfaces/cli-operational-reachability.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (the CLI surface only routes; it never imports `sandbox-entrypoint.ts`).
- Produces: `WakeCommand` variant `{ kind: 'sandbox-entrypoint'; arguments: readonly string[] }`; `WakeCliApplications.operational.sandboxEntrypoint: (arguments_: readonly string[]) => Promise<void>`. Task 3 implements this member.

- [ ] **Step 1: Write the failing tests**

In `test-next/integration/surfaces/cli-operational-reachability.test.ts`, change the `it.each` list and add a dispatch case:

```ts
  it.each(
    ['init', 'doctor', 'sandbox', 'sandbox-setup', 'sandbox-entrypoint', 'self-update', 'smoke'] as const,
  )('parses %s as a target command', (name) => {
    expect(parseWakeCommand([name]).kind).toBe(name);
  });
```

Add a new test in the same file, after the existing `'dispatches doctor through the injected target operational application'` test:

```ts
  it('dispatches sandbox-entrypoint through the injected target operational application', async () => {
    const calls: (readonly string[])[] = [];
    await runWakeCommand(
      parseWakeCommand(['sandbox-entrypoint', '--wake-root', '/wake']),
      {
        tick: { run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'idle' }) },
        start: { run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'idle' }) },
        stop: { stop: async () => undefined },
        api: { start: async () => undefined },
        ui: { start: async () => undefined },
        audit: { read: async () => [] },
        correlate: { correlate: async () => ({}) },
        validateState: {
          health: async () => ({ journal: 'ok', projections: 'ok', checkpoints: 'ok' }),
          rebuildProjections: async () => undefined,
        },
        operational: {
          init: async () => ({ wakeRoot: '/tmp/wake' }),
          doctor: async () => ({ failures: [], notices: [] }),
          sandbox: async () => undefined,
          sandboxSetup: async () => undefined,
          sandboxEntrypoint: async (arguments_) => {
            calls.push(arguments_);
          },
          selfUpdate: async () => ({ updated: false }),
          smoke: async () => ({ ok: true }),
        },
      },
      { write: () => {} },
      new AbortController().signal,
    );
    expect(calls).toEqual([['--wake-root', '/wake']]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test-next/integration/surfaces/cli-operational-reachability.test.ts`
Expected: FAIL — `sandbox-entrypoint` is not a recognized command kind, and `operational.sandboxEntrypoint` does not exist on the type.

- [ ] **Step 3: Wire the command**

In `src-next/surfaces/cli/main.ts`, extend the `WakeCommand` union (the bucket sharing `arguments: readonly string[]`):

```ts
  | {
      readonly kind:
        | 'init'
        | 'doctor'
        | 'sandbox-setup'
        | 'sandbox-entrypoint'
        | 'self-update'
        | 'smoke';
      readonly arguments: readonly string[];
    }
```

Add `sandboxEntrypoint` to `WakeCliApplications.operational`:

```ts
  readonly operational?: {
    readonly init: (arguments_: readonly string[]) => Promise<unknown>;
    readonly doctor: (arguments_: readonly string[]) => Promise<unknown>;
    readonly sandbox: (arguments_: readonly string[]) => Promise<unknown>;
    readonly sandboxSetup: (arguments_: readonly string[]) => Promise<unknown>;
    readonly sandboxEntrypoint: (arguments_: readonly string[]) => Promise<unknown>;
    readonly selfUpdate: (arguments_: readonly string[]) => Promise<unknown>;
    readonly smoke: (arguments_: readonly string[]) => Promise<unknown>;
  };
```

Add `'sandbox-entrypoint'` to the `parseWakeCommand` switch case that already lists `'sandbox-setup'`:

```ts
    case 'init':
    case 'doctor':
    case 'sandbox-setup':
    case 'sandbox-entrypoint':
    case 'sandbox':
    case 'self-update':
    case 'smoke':
      return { kind: command, arguments: arguments_.slice(1) };
```

Add a dispatch case in `runWakeCommand`, right after the existing `'sandbox-setup'` case:

```ts
    case 'sandbox-entrypoint':
      await operational(applications).sandboxEntrypoint(command.arguments);
      return;
```

In `src-next/surfaces/cli/usage.ts`, add the command to the closed list:

```ts
export const usage = `wake <tick|start|stop|api|ui|audit|correlate|validate-state|init|doctor|sandbox|sandbox-entrypoint|self-update|smoke>`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test-next/integration/surfaces/cli-operational-reachability.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-next/surfaces/cli/main.ts src-next/surfaces/cli/usage.ts test-next/integration/surfaces/cli-operational-reachability.test.ts
git commit -m "feat(surfaces): route sandbox-entrypoint through the CLI command surface"
```

---

### Task 3: Compose real dependencies in Bootstrap

**Files:**
- Modify: `src-next/bootstrap/surface-cli-applications.ts`

**Interfaces:**
- Consumes: `runSandboxEntrypoint`, `SandboxEntrypointDependencies` from Task 1 (`../surfaces/index.js` — confirm/extend the `surfaces` barrel export in Step 1 below); `sandboxWakeInvocation(root)` (already defined lower in this same file, reused as-is).
- Produces: `WakeCliApplications.operational.sandboxEntrypoint`, satisfying Task 2's interface.

- [ ] **Step 1: Export the new command from the surfaces barrel**

Find the CLI commands barrel export (`src-next/surfaces/index.ts` — check how `runSandboxSetup` is currently re-exported, and add `runSandboxEntrypoint`/`SandboxEntrypointDependencies` alongside it with the same export style).

- [ ] **Step 2: Write the failing/updated test**

In `test-next/integration/surfaces/cli-operational-reachability.test.ts`'s doctor-dispatch-style test is process-level only (fakes); Bootstrap's own composition wiring for `sandboxSetup` has no dedicated composition-level test today (it only exercises `runSandboxSetup` directly via unit test, per `test-next/unit/surfaces/sandbox-setup.test.ts`). Follow the same precedent: no new test file for the composition glue itself — Task 1's unit tests already cover `runSandboxEntrypoint`'s behavioural contract, and Task 2's test already confirms the CLI surface calls whatever `operational.sandboxEntrypoint` it's given. Skip to Step 3.

- [ ] **Step 3: Wire production dependencies**

In `src-next/bootstrap/surface-cli-applications.ts`:

Add `writeFile` to the existing `node:fs/promises` import:

```ts
import { access, copyFile, mkdir, writeFile as writeFileContent } from 'node:fs/promises';
```

Add a `ChildProcess` type import next to the existing `node:child_process` import:

```ts
import { execFile as nodeExecFile, spawn, type ChildProcess } from 'node:child_process';
```

Add `runSandboxEntrypoint` and its dependency type to the existing `../surfaces/index.js` import list (alphabetical, alongside `runSandboxSetup`):

```ts
  runSandboxEntrypoint,
  runSandboxSetup,
```

and

```ts
  type SandboxEntrypointDependencies,
```

Add the new operational entry in `createOperationalApplications`, right after the existing `sandboxSetup` entry:

```ts
    sandboxEntrypoint: async () => {
      await runSandboxEntrypoint(createSandboxEntrypointDependencies(root));
    },
```

Add the composition function near `createSandboxSetupDependencies` at the bottom of the file:

```ts
const DEFAULT_START_RESTART_DELAY_SECONDS = 10;

function createSandboxEntrypointDependencies(root: CompositionRoot): SandboxEntrypointDependencies {
  const logDirectory = join(root.paths.dataRoot, 'logs');
  const pidFile = join(logDirectory, 'start.pid');
  const startLogFile = join(logDirectory, 'start.log');
  const children = new Map<number, ChildProcess>();
  return {
    startEnabled: process.env.WAKE_START_ENABLED === 'true',
    restartDelaySeconds: resolveRestartDelaySeconds(process.env),
    wakeInvocation: sandboxWakeInvocation(root),
    pidFile,
    startLogFile,
    ensureLogDirectory: async () => {
      await mkdir(logDirectory, { recursive: true });
    },
    spawnDetached: (command, arguments_, options) => {
      const sink = createProcessLogSink(
        options.logFile,
        { write: () => {} },
        { maxBytes: 10 * 1024 * 1024 },
      );
      const child = spawn(command, [...arguments_], {
        cwd: root.paths.wakeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      if (typeof child.pid !== 'number')
        throw new Error('failed to spawn detached wake start process');
      children.set(child.pid, child);
      const forward = (chunk: Buffer) => void sink.write(chunk.toString('utf8'));
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
      child.on('exit', () => {
        if (typeof child.pid === 'number') children.delete(child.pid);
        void sink.close();
      });
      child.unref();
      return { pid: child.pid };
    },
    waitForExit: (pid) =>
      new Promise<number>((resolve) => {
        const child = children.get(pid);
        if (child === undefined) {
          resolve(1);
          return;
        }
        child.on('exit', (code) => resolve(code ?? 1));
      }),
    writeFile: (path, content) => writeFileContent(path, content, 'utf8'),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    waitForever: () => new Promise<never>(() => {}),
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

function resolveRestartDelaySeconds(env: NodeJS.ProcessEnv): number {
  const value = env.WAKE_START_RESTART_DELAY_SECONDS;
  if (value === undefined) return DEFAULT_START_RESTART_DELAY_SECONDS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_START_RESTART_DELAY_SECONDS;
}
```

- [ ] **Step 4: Run the full target test suite and the type checker**

Run: `npx vitest run test-next/integration/surfaces/cli-operational-reachability.test.ts test-next/unit/surfaces/sandbox-entrypoint.test.ts`
Expected: PASS

Run: `npm run build`
Expected: no type errors (confirms `writeFileContent` alias avoids colliding with the `writeFile` local variable name used elsewhere, and that `WakeCliApplications['operational']` is fully satisfied).

- [ ] **Step 5: Commit**

```bash
git add src-next/bootstrap/surface-cli-applications.ts src-next/surfaces/index.ts
git commit -m "feat(bootstrap): compose real sandbox-entrypoint supervisor dependencies"
```

---

### Task 4: Point the source-mode Dockerfile template at the supervisor

**Files:**
- Modify: `src-next/bootstrap/initialise.ts`
- Modify: `test-next/integration/bootstrap/initialise.test.ts`

**Interfaces:**
- Consumes: nothing new; this only changes a template string.

- [ ] **Step 1: Write the failing test**

Add to `test-next/integration/bootstrap/initialise.test.ts`, in the existing `'writes a Dockerfile that installs the runner CLIs...'` test (or a new one right after it):

```ts
  it('points the source-mode Dockerfile entrypoint at the supervised sandbox-entrypoint command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-initialise-root-'));
    await initialiseWakeRoot(root);

    const dockerfile = await readFile(join(root, 'docker', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('ENV WAKE_MAIN_JS=/app/dist-next/src-next/main.js');
    expect(dockerfile).toContain('sandbox-entrypoint');
    expect(dockerfile).not.toContain('sleep infinity');
    expect(dockerfile).not.toContain('WAKE_START_ENABLED" = "true"');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test-next/integration/bootstrap/initialise.test.ts`
Expected: FAIL — current template still contains the `if [ "$WAKE_START_ENABLED" ...` / `sleep infinity` one-shot script, not `sandbox-entrypoint`.

- [ ] **Step 3: Replace the ENTRYPOINT template**

In `src-next/bootstrap/initialise.ts`, replace the source-mode Dockerfile's final lines (currently):

```ts
ENV WAKE_MAIN_JS=/app/dist-next/src-next/main.js

ENTRYPOINT ["sh", "-c", "if [ \\"$WAKE_START_ENABLED\\" = \\"true\\" ]; then exec node /app/dist-next/src-next/main.js start --wake-root /wake --no-sandbox; else exec sleep infinity; fi"]
`;
```

with:

```ts
ENV WAKE_MAIN_JS=/app/dist-next/src-next/main.js

# The supervised entrypoint (surfaces/cli/commands/sandbox-entrypoint.ts) is
# PID 1 and never exits on its own, so the container always stays reachable
# for \`docker exec\` (i.e. \`wake sandbox setup\`/\`wake sandbox exec\`) even
# when WAKE_START_ENABLED's supervised \`wake start\` child keeps crashing —
# e.g. on first boot, before sandbox auth has been configured.
ENTRYPOINT ["sh", "-c", "exec node \\"$WAKE_MAIN_JS\\" sandbox-entrypoint --wake-root /wake"]
`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test-next/integration/bootstrap/initialise.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add src-next/bootstrap/initialise.ts test-next/integration/bootstrap/initialise.test.ts
git commit -m "fix(bootstrap): keep the source-mode sandbox container alive across a wake start crash"
```

---

### Task 5: Update reference docs and module specs

**Files:**
- Modify: `docs/getting-started.md`
- Modify: `src-next/surfaces/cli/cli-surface.spec.md`
- Modify: `src-next/surfaces/SPEC.md`

**Interfaces:**
- None — documentation only.

- [ ] **Step 1: Update `docs/getting-started.md`**

In the `## Build and start the sandbox` section, after the existing `sandbox up` bullet, add:

```markdown
- `sandbox up` starts a container that supervises the resident loop and
  restarts it automatically if it exits (for example because sandbox auth
  isn't configured yet) — the container itself never exits, so `sandbox
  setup` and `sandbox exec` can always reach it.
```

- [ ] **Step 2: Update `src-next/surfaces/cli/cli-surface.spec.md`**

In the "Command primitive" bullet under `## Ubiquitous language`, add `sandbox-entrypoint` to the named examples:

```markdown
- **Command primitive** — a small function under `cli/commands/` (e.g.
  `init`, `sandbox`, `doctor`, `self-update`, `smoke`, `sandbox-entrypoint`,
  and the ones wired into `WakeCommand`) performing exactly one CLI action
  against a narrow interface, independent of `parseWakeCommand`'s argument
  grammar.
```

In `## Decisions, exclusions, and deferred capability`, extend the first bullet:

```markdown
- `init`, `doctor`, `sandbox`, `sandbox-setup`, `sandbox-entrypoint`,
  `self-update`, and `smoke` are parsed and routed through the operational
  Surface port. `init` executes before composition because it creates the
  root; `doctor`, `sandbox`, `sandbox-entrypoint`, and `smoke` are
  Bootstrap-composed target applications. `self-update` remains a Surface
  command with an injected update boundary.
```

- [ ] **Step 3: Update `src-next/surfaces/SPEC.md`**

Update the closed-vocabulary line (currently missing `sandbox-setup` too — fold both into the same edit since this line is being touched regardless):

```markdown
- The CLI command parser recognizes `tick`, `start`, `stop`, `api`, `ui`, `audit`, `correlate`, `validate-state`, `init`, `doctor`, `sandbox`, `sandbox-setup`, `sandbox-entrypoint`, `self-update`, and `smoke`. `init` creates its root before Bootstrap composes it. The other operational commands route through a Bootstrap-owned operational Surface port.
```

- [ ] **Step 4: Verify spec sync**

Run: `npm run check:specs`
Expected: `surfaces` no longer reported as drifted for this change (other pre-existing drift in unrelated modules, if any, is out of scope).

- [ ] **Step 5: Commit**

```bash
git add docs/getting-started.md src-next/surfaces/cli/cli-surface.spec.md src-next/surfaces/SPEC.md
git commit -m "docs: describe the supervised sandbox-entrypoint container lifecycle"
```

---

### Task 6: Full verification and live sandbox re-check

**Files:** none (verification only).

- [ ] **Step 1: Run the full target gate**

Run, in order, stopping to fix on any failure:
```bash
npm run lint:contracts
npm run lint:architecture
npm run knip:next
npm run verify:next
npm run verify
```
Expected: all pass.

- [ ] **Step 2: Rebuild the affected local sandbox image**

This talks to the user's real Docker daemon and the `wake-sandbox-wake-next`
container referenced in the original bug report — confirm with the user
before running, since it rebuilds/replaces a real local image and container.

```bash
wake-dev sandbox build
```
(or the equivalent `wake sandbox build` invocation the user's Wake home
actually uses — check which binary/wake-root they run from first.)

- [ ] **Step 3: Confirm the container survives a pre-auth boot**

```bash
wake-dev sandbox update
docker ps -a --filter name=wake-sandbox-wake-next --format '{{.Status}}'
```
Expected: container shows `Up ...`, not `Exited`, even though `gh auth` is
not yet configured inside it. Tail `docker logs` and confirm repeated
`wake start: resident loop exited with status 1; restarting in Ns` lines
instead of the container dying.

- [ ] **Step 4: Confirm `sandbox setup` now works from this state**

```bash
wake-dev sandbox setup
```
Expected: the interactive setup wizard runs (not `sandbox is not started`).
Complete `gh auth login`, then re-check `docker logs` for the resident loop
starting successfully.

- [ ] **Step 5: Report back to the user**

Summarize what changed and the verified before/after container behavior;
do not commit anything from this task (verification only).
