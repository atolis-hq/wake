# CLI Help and Container Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--help`/`-h`/`help` handling, make bare `wake` print help instead of defaulting to `tick`, replace the raw-stack-trace unknown-command crash with a clean error, and derive `sandbox.containerName` from the wake-root directory name at `init` time instead of a fixed literal.

**Architecture:** A new `printUsage()` helper and `CliUsageError` class in `src/main.ts` handle the CLI-surface changes; `dispatchMainCommand`'s command-matching `if` chain gains a `--help`/`-h`/`help` branch before the existing default-to-`tick` fallback, and its final unknown-command branch throws `CliUsageError` instead of a raw `Error`. `main()`'s top-level catch special-cases `CliUsageError` to print only the message. Container naming is a small addition to `src/cli/scaffold-assets.ts`'s existing config-construction step, sanitizing `basename(wakeRoot)` into a Docker-legal container-name suffix.

**Tech Stack:** TypeScript, Vitest, Node `node:path`.

## Global Constraints

- Bare `wake` (no args) now prints help and exits 0 instead of running `tick` — this is a deliberate behavior change per the spec; do not preserve the old default as a fallback.
- `sandbox.image` and `sandbox.imageRepository` stay the literal default `"wake-sandbox"` — only `sandbox.containerName` becomes per-project. Do not touch `image`/`imageRepository`.
- No collision detection against a live Docker daemon and no path-hash suffix for container naming — dirname-derived only, per the spec's decided scope.
- `dispatchMainCommand`'s existing throw-based contract for callers/tests is unchanged — no return-value or exit-code parameter added to its signature.
- Update `README.md`'s "Getting Started" section with a one-line `wake --help` pointer once the command exists — keep the addition minimal, no structural rewrite.
- Run `npm run verify` before considering the branch done (per `CLAUDE.md`). Any file you touch must have no real prettier diff — write with `npx prettier --write --end-of-line lf <file>`.

---

### Task 1: `printUsage()` and `CliUsageError`

**Files:**

- Modify: `src/main.ts`
- Test: `test/cli/main.test.ts`

**Interfaces:**

- Produces: `export class CliUsageError extends Error {}` and `export function printUsage(stream: NodeJS.WritableStream): void`, both exported from `src/main.ts`. `printUsage` writes a fixed multi-line usage string (see Step 3) to the given stream, ending in a trailing newline via a single `stream.write(...)` call.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli/main.test.ts` (new `describe` block, alongside the existing `describe('main command routing', ...)`):

```typescript
import { CliUsageError, printUsage } from '../../src/main.js';

describe('printUsage', () => {
  it('writes a usage summary mentioning every command and both entry points', () => {
    const chunks: string[] = [];
    const stream = { write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WritableStream;

    printUsage(stream);

    const output = chunks.join('');
    expect(output).toContain('wake init');
    expect(output).toContain('wake.sh');
    expect(output).toContain('tick');
    expect(output).toContain('start');
    expect(output).toContain('sandbox');
    expect(output).toContain('stop');
    expect(output).toContain('smoke');
    expect(output).toContain('ui');
    expect(output).toContain('correlate');
    expect(output).toContain('version');
  });
});

describe('CliUsageError', () => {
  it('is an Error subclass carrying its message', () => {
    const error = new CliUsageError('Unknown command: bogus');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Unknown command: bogus');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/main.test.ts -t "printUsage"`
Expected: FAIL — `printUsage`/`CliUsageError` are not exported from `src/main.ts` yet.

- [ ] **Step 3: Implement `printUsage` and `CliUsageError`**

In `src/main.ts`, near the top-level function declarations (above `dispatchMainCommand`), add:

```typescript
export class CliUsageError extends Error {}

export function printUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    [
      'Wake — an autonomous agent control plane for software development.',
      '',
      'Usage:',
      '  wake init <path>           Scaffold a new Wake home directory',
      '  wake sandbox <subcommand>  Build/run/manage the Docker sandbox (build, up, update, down, stop, self-update, setup, exec, logs, resume)',
      '  wake tick                  Run one control-plane tick',
      '  wake start                 Run the resident loop',
      '  wake stop                  Stop the sandbox container gracefully',
      '  wake smoke                 Smoke-test the configured runner',
      '  wake ui                    Run the control-plane UI server',
      '  wake correlate             Manually correlate a resource to a work item',
      '  wake version               Print the installed Wake version',
      '  wake --help                Show this message',
      '',
      'Getting started:',
      '  1. wake init ./wake-home',
      '  2. cd wake-home && ./wake.sh start   (or ./wake.ps1 start on Windows)',
      '',
      'The bare `wake` binary runs directly on the host. The generated wake.sh/wake.ps1',
      'launcher routes runtime commands (tick/start/ui/smoke/correlate) into the sandbox.',
      '',
    ].join('\n'),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/main.test.ts -t "printUsage|CliUsageError"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.ts test/cli/main.test.ts
git commit -m "Add printUsage helper and CliUsageError class"
```

---

### Task 2: Wire `--help`/`-h`/`help`, bare-args help, and clean unknown-command errors into `dispatchMainCommand`

**Files:**

- Modify: `src/main.ts`
- Test: `test/cli/main.test.ts`

**Interfaces:**

- Consumes: `printUsage(stream)`, `CliUsageError` from Task 1.
- Produces: no new exports — behavior change to `dispatchMainCommand`.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli/main.test.ts`:

```typescript
describe('help and unknown-command handling', () => {
  function noopHandlers() {
    return {
      runInit: async () => {},
      runSandbox: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
    };
  }

  it.each(['--help', '-h', 'help'])('prints usage for %s and calls no handler', async (flag) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dispatchMainCommand({ args: [flag], ...noopHandlers() });

    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('prints usage for bare args (no command) and calls no handler', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({ args: [], ...noopHandlers(), runTick });

    expect(log).toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('throws CliUsageError with the offending command for an unknown command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      dispatchMainCommand({ args: ['bogus-command'], ...noopHandlers() }),
    ).rejects.toThrow(CliUsageError);
    await expect(
      dispatchMainCommand({ args: ['bogus-command'], ...noopHandlers() }),
    ).rejects.toThrow('Unknown command: bogus-command');

    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/main.test.ts -t "help and unknown-command handling"`
Expected: FAIL — bare args currently calls `runTick`, unknown command throws a plain `Error`, `--help` is unrecognized and falls through to the unknown-command branch.

- [ ] **Step 3: Implement the dispatch changes**

In `src/main.ts`, locate `dispatchMainCommand` (around line 507). Change:

```typescript
const command = input.args[0] ?? 'tick';
if (command === '--version' || command === '-v' || command === 'version') {
  console.log(wakeVersion);
  return;
}
```

to:

```typescript
const command = input.args[0] ?? 'help';
if (command === '--version' || command === '-v' || command === 'version') {
  console.log(wakeVersion);
  return;
}

if (command === '--help' || command === '-h' || command === 'help') {
  printUsage(process.stdout);
  return;
}
```

And change the final line of `dispatchMainCommand` from:

```typescript
throw new Error(`Unknown command: ${input.args.join(' ')}`);
```

to:

```typescript
printUsage(process.stderr);
throw new CliUsageError(`Unknown command: ${input.args.join(' ')}`);
```

Note `console.log` is used for `--help`/bare-args (stdout, matching `version`'s existing convention) while the unknown-command path writes usage to stderr via `printUsage(process.stderr)` before throwing — the test above asserts on `console.log` for the help paths only, not the throw path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/main.test.ts`
Expected: PASS (full file, including all pre-existing tests — confirms no routing regression)

- [ ] **Step 5: Commit**

```bash
git add src/main.ts test/cli/main.test.ts
git commit -m "Add --help/-h/help handling; bare wake and unknown commands no longer crash silently or with a stack trace"
```

---

### Task 3: `main()`'s catch distinguishes `CliUsageError`

**Files:**

- Modify: `src/main.ts`

**Interfaces:**

- Consumes: `CliUsageError` from Task 1.

- [ ] **Step 1: Make the change directly (behavior not practically unit-testable without restructuring `main()`'s top-level `process.argv` wiring — verified manually in Task 4)**

In `src/main.ts`, locate the bottom of the file:

```typescript
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Change to:

```typescript
main().catch((error) => {
  if (error instanceof CliUsageError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
```

- [ ] **Step 2: Build and manually verify**

Run: `npm run build`
Then run: `node dist/src/main.js bogus-command`
Expected: stderr shows the usage summary followed by `Unknown command: bogus-command` — no `at dispatchMainCommand (...)` stack trace lines. Exit code 1 (check with `echo $?` on bash or `$LASTEXITCODE` on PowerShell).

Then run: `node dist/src/main.js --help`
Expected: usage summary printed to stdout, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "main() prints a clean message for CliUsageError instead of a full stack trace"
```

---

### Task 4: Per-project default `containerName`

**Files:**

- Modify: `src/cli/scaffold-assets.ts`
- Test: `test/cli/scaffold-assets.test.ts`

**Interfaces:**

- Produces: `sanitizeContainerName(name: string): string`, a non-exported helper in `scaffold-assets.ts` (exported only if the existing test file's pattern requires importing internals directly — check the existing test file first and match its import style; if it only tests `scaffoldWakeHome`'s output, keep this unexported and test it indirectly through the written `config.json`).

- [ ] **Step 1: Read the existing test file to confirm import/test style**

Run: `grep -n "^import\|scaffoldWakeHome\|createDefaultWakeConfig" test/cli/scaffold-assets.test.ts`

Match whatever pattern is already used for asserting on `config.json` contents after calling `scaffoldWakeHome`.

- [ ] **Step 2: Write the failing tests**

Add to `test/cli/scaffold-assets.test.ts` (adjust the exact setup/teardown helpers to match what the existing tests in that file already use for a temp `wakeRoot` and `repoRoot`):

```typescript
it('derives sandbox.containerName from the wake-root directory name', async () => {
  // reuse this file's existing temp-dir setup helpers; wakeRoot's basename here is "my-project"
  const wakeRoot = await makeTempWakeRoot('my-project'); // adjust to existing helper name/signature
  await scaffoldWakeHome({ wakeRoot, repoRoot });

  const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));

  expect(config.sandbox.containerName).toBe('wake-sandbox-my-project');
  expect(config.sandbox.image).toBe('wake-sandbox');
  expect(config.sandbox.imageRepository).toBe('wake-sandbox');
});

it('sanitizes an uppercase/space/special-character directory name for containerName', async () => {
  const wakeRoot = await makeTempWakeRoot('My Project! (v2)');
  await scaffoldWakeHome({ wakeRoot, repoRoot });

  const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));

  expect(config.sandbox.containerName).toBe('wake-sandbox-my-project-v2');
});
```

If this file has no existing "make a temp wake-root with a specific basename" helper, write the directory creation inline with `mkdtemp`/`join` instead of inventing a new shared helper — match whatever the file's other tests already do for their temp directories.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/cli/scaffold-assets.test.ts -t "containerName"`
Expected: FAIL — `config.sandbox.containerName` is currently the literal `"wake-sandbox"` regardless of directory name.

- [ ] **Step 4: Implement `sanitizeContainerName` and wire it into `scaffoldWakeHome`**

In `src/cli/scaffold-assets.ts`, add near the top of the file (after imports):

```typescript
function sanitizeContainerName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return sanitized.length > 0 ? sanitized : 'wake';
}
```

Locate `scaffoldWakeHome` (around line 175):

```typescript
export async function scaffoldWakeHome(input: {
  wakeRoot: string;
  repoRoot: string;
}): Promise<void> {
  const wakeRoot = resolve(input.wakeRoot);
  const repoRoot = resolve(input.repoRoot);
  const config = {
    ...createDefaultWakeConfig(wakeRoot),
    dev: {
      repoRoot,
    },
  };
```

Change the `config` construction to also override `sandbox.containerName`, using `basename` (already need to import it from `node:path` if not already imported — check the existing import line at the top of the file and extend it rather than adding a duplicate import):

```typescript
export async function scaffoldWakeHome(input: {
  wakeRoot: string;
  repoRoot: string;
}): Promise<void> {
  const wakeRoot = resolve(input.wakeRoot);
  const repoRoot = resolve(input.repoRoot);
  const defaults = createDefaultWakeConfig(wakeRoot);
  const config = {
    ...defaults,
    sandbox: {
      ...defaults.sandbox,
      containerName: `wake-sandbox-${sanitizeContainerName(basename(wakeRoot))}`,
    },
    dev: {
      repoRoot,
    },
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cli/scaffold-assets.test.ts`
Expected: PASS (full file — confirms no regression to existing scaffold assertions)

- [ ] **Step 6: Commit**

```bash
git add src/cli/scaffold-assets.ts test/cli/scaffold-assets.test.ts
git commit -m "Derive default sandbox.containerName from the wake-root directory name"
```

---

### Task 5: README pointer to `wake --help`

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add the pointer**

In `README.md`'s "Getting Started" section (search for `## Getting Started`), after the existing `wake init` walkthrough paragraph, add one line:

```markdown
Run `wake --help` at any time for the full command list.
```

- [ ] **Step 2: Verify formatting**

Run: `npx prettier --check README.md`
Expected: no diff (or run `npx prettier --write --end-of-line lf README.md` if it reports one, then re-check).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Point README at wake --help"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: lint, format:check, build, and test all pass. If `format:check` reports CRLF-only diffs on files you didn't touch, that's the known Windows `core.autocrlf` false positive (per `CLAUDE.md`) — ignore those, but confirm every file *this plan* touched has no real diff via `npx prettier --check <file>`.

- [ ] **Step 2: Commit if verify required any fixes**

```bash
git add -A
git commit -m "Fix verify failures"
```
