# wake doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone `wake doctor` command that runs the existing `runStartupPreflight` checks on demand (not only inside `wake start`), plus three new checks: GitHub token resolvability, Docker/sandbox reachability, and informational version/prompt-drift staleness reporting.

**Architecture:** `runStartupPreflight` (`src/cli/startup-preflight.ts`) is extended to accept the new checks as additional optional dependencies, so `wake start`'s existing call site and `wake doctor`'s new call site share one implementation. A new `doctor-command.ts` wires real dependencies (GitHub token resolution, Docker inspection, container version exec, prompt/Dockerfile diffing) and formats a two-section report: hard failures (exit 1) and informational notices (never affect exit code).

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- This plan depends on the wake-home-restructure plan having landed — it assumes the `.wake/`-nested layout and the `docker/Dockerfile`-presence signal for sandbox usage. Do not start this plan until that one is merged.
- `wake doctor` never mutates anything — no auto-rebuild, no auto-overwrite of drifted prompts/Dockerfile.
- Version/drift checks are informational only and must never contribute to the command's exit code.
- Run `npm run verify` before considering the branch done (per `CLAUDE.md`).

---

### Task 1: Extract preflight checks into a reusable, standalone-callable shape

**Files:**

- Modify: `src/cli/startup-preflight.ts`
- Test: `test/cli/startup-preflight.test.ts`

**Interfaces:**

- Produces: `runStartupPreflight` gains a non-throwing variant, `collectStartupPreflightFailures(config, deps): Promise<string[]>`, returning the same `failures` array it currently only ever throws (via `formatPreflightFailures`) — `runStartupPreflight` itself becomes a thin wrapper that calls this and throws if non-empty, preserving its existing external behavior/signature exactly for `wake start`'s call site.

- [ ] **Step 1: Write the failing test**

Add to `test/cli/startup-preflight.test.ts`:

```typescript
import { collectStartupPreflightFailures } from '../../src/cli/startup-preflight.js';

it('collectStartupPreflightFailures returns the same failures runStartupPreflight would throw, without throwing', async () => {
  // reuse this file's existing "failing" fixture setup (bad prompt root, or
  // similar) that today causes runStartupPreflight to throw
  const failures = await collectStartupPreflightFailures(badConfig, badDeps);

  expect(failures.length).toBeGreaterThan(0);
  expect(failures[0]).toContain('not readable'); // match whatever the existing throw-path test already asserts on
});

it('collectStartupPreflightFailures returns an empty array for a fully valid config', async () => {
  const failures = await collectStartupPreflightFailures(goodConfig, goodDeps);
  expect(failures).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/startup-preflight.test.ts -t "collectStartupPreflightFailures"`
Expected: FAIL — not exported yet.

- [ ] **Step 3: Implement the extraction**

In `src/cli/startup-preflight.ts`, rename the body of `runStartupPreflight` into a new exported function that returns `failures` instead of throwing, and make `runStartupPreflight` call it:

```typescript
export async function collectStartupPreflightFailures(
  config: WakeConfig,
  deps: StartupPreflightDeps = {},
): Promise<string[]> {
  const failures: string[] = [];
  // ... exact existing body of runStartupPreflight up to (not including) the
  // `if (failures.length > 0) { throw formatPreflightFailures(failures); }` check
  return failures;
}

export async function runStartupPreflight(
  config: WakeConfig,
  deps: StartupPreflightDeps = {},
): Promise<void> {
  const failures = await collectStartupPreflightFailures(config, deps);
  if (failures.length > 0) {
    throw formatPreflightFailures(failures);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/startup-preflight.test.ts`
Expected: PASS (full file — confirms `wake start`'s existing preflight behavior is unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/cli/startup-preflight.ts test/cli/startup-preflight.test.ts
git commit -m "Extract collectStartupPreflightFailures for standalone reuse by wake doctor"
```

---

### Task 2: GitHub token resolvability check

**Files:**

- Create: `src/cli/doctor-command.ts`
- Test: `test/cli/doctor-command.test.ts`

**Interfaces:**

- Produces: `export async function runDoctorCommand(config: WakeConfig, deps: DoctorDeps): Promise<DoctorReport>`, `export type DoctorReport = { failures: string[]; notices: string[] }`, `export type DoctorDeps = { collectPreflightFailures: (config: WakeConfig) => Promise<string[]>; resolveGitHubToken: () => Promise<string>; ... }` (remaining fields added in later tasks of this plan).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/cli/doctor-command.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runDoctorCommand } from '../../src/cli/doctor-command.js';

const baseConfig = {
  sources: { github: { enabled: false, repos: [] } },
  // ...minimal valid WakeConfig fields, matching this repo's existing test fixture pattern
} as any;

describe('runDoctorCommand — GitHub token check', () => {
  it('adds a failure when github source is enabled and the token cannot be resolved', async () => {
    const report = await runDoctorCommand(
      { ...baseConfig, sources: { github: { enabled: true, repos: [] } } },
      {
        collectPreflightFailures: async () => [],
        resolveGitHubToken: async () => {
          throw new Error('gh auth token failed');
        },
      } as any,
    );

    expect(report.failures.some((f) => f.includes('GitHub token'))).toBe(true);
  });

  it('does not check the token when github source is disabled', async () => {
    const resolveGitHubToken = vi.fn(async () => 'tok');

    await runDoctorCommand(baseConfig, {
      collectPreflightFailures: async () => [],
      resolveGitHubToken,
    } as any);

    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });

  it('includes existing preflight failures verbatim', async () => {
    const report = await runDoctorCommand(baseConfig, {
      collectPreflightFailures: async () => ['prompt template x.md is not readable'],
      resolveGitHubToken: async () => 'tok',
    } as any);

    expect(report.failures).toContain('prompt template x.md is not readable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/doctor-command.test.ts`
Expected: FAIL — `src/cli/doctor-command.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/cli/doctor-command.ts`:

```typescript
import type { WakeConfig } from '../domain/types.js';

export type DoctorDeps = {
  collectPreflightFailures: (config: WakeConfig) => Promise<string[]>;
  resolveGitHubToken: () => Promise<string>;
};

export type DoctorReport = {
  failures: string[];
  notices: string[];
};

export async function runDoctorCommand(
  config: WakeConfig,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  const failures = [...(await deps.collectPreflightFailures(config))];
  const notices: string[] = [];

  if (config.sources.github.enabled) {
    try {
      await deps.resolveGitHubToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`GitHub token could not be resolved: ${message}`);
    }
  }

  return { failures, notices };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/doctor-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor-command.ts test/cli/doctor-command.test.ts
git commit -m "Add wake doctor with existing preflight checks plus GitHub token resolvability"
```

---

### Task 3: Docker/sandbox reachability check

**Files:**

- Modify: `src/cli/doctor-command.ts`
- Test: `test/cli/doctor-command.test.ts`

**Interfaces:**

- Consumes: reuses the same `inspectDockerImage`/`inspectDockerContainer` shape already defined and wired in `main.ts` (`grep -n "inspectDockerImage\|inspectDockerContainer" src/main.ts` for the exact signatures before implementing).
- Produces: `DoctorDeps` gains `hasDockerfile: (wakeRoot: string) => Promise<boolean>` (reuse the `hasDockerfile` helper from the wake-home-restructure plan's Task 3 — import it from `main.ts` if exported there, or from wherever it ends up living), `dockerReachable: () => Promise<boolean>`, `inspectImage: (image: string) => Promise<boolean>`, `wakeRoot: string`, `image: string`.

- [ ] **Step 1: Write the failing tests**

```typescript
it('adds a failure when docker/Dockerfile exists but the Docker daemon is unreachable', async () => {
  const report = await runDoctorCommand(baseConfig, {
    collectPreflightFailures: async () => [],
    resolveGitHubToken: async () => 'tok',
    hasDockerfile: async () => true,
    dockerReachable: async () => false,
    inspectImage: async () => false,
    wakeRoot: '/tmp/wake',
    image: 'wake-sandbox-x',
  } as any);

  expect(report.failures.some((f) => f.includes('Docker'))).toBe(true);
});

it('does not check Docker reachability when there is no docker/Dockerfile', async () => {
  const dockerReachable = vi.fn(async () => true);

  await runDoctorCommand(baseConfig, {
    collectPreflightFailures: async () => [],
    resolveGitHubToken: async () => 'tok',
    hasDockerfile: async () => false,
    dockerReachable,
    inspectImage: async () => true,
    wakeRoot: '/tmp/wake',
    image: 'wake-sandbox-x',
  } as any);

  expect(dockerReachable).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/doctor-command.test.ts -t "Docker"`
Expected: FAIL

- [ ] **Step 3: Implement**

Extend `DoctorDeps` and `runDoctorCommand`:

```typescript
export type DoctorDeps = {
  collectPreflightFailures: (config: WakeConfig) => Promise<string[]>;
  resolveGitHubToken: () => Promise<string>;
  hasDockerfile: (wakeRoot: string) => Promise<boolean>;
  dockerReachable: () => Promise<boolean>;
  inspectImage: (image: string) => Promise<boolean>;
  wakeRoot: string;
  image: string;
};
```

```typescript
  if (await deps.hasDockerfile(deps.wakeRoot)) {
    const reachable = await deps.dockerReachable();
    if (!reachable) {
      failures.push('Docker daemon is not reachable');
    } else {
      const imageExists = await deps.inspectImage(deps.image);
      if (!imageExists) {
        failures.push(`sandbox image "${deps.image}" not found — run \`wake sandbox build\``);
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/doctor-command.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor-command.ts test/cli/doctor-command.test.ts
git commit -m "Add Docker/sandbox reachability check to wake doctor"
```

---

### Task 4: Version and prompt/Dockerfile drift notices

**Files:**

- Modify: `src/cli/doctor-command.ts`
- Test: `test/cli/doctor-command.test.ts`

**Interfaces:**

- Produces: `DoctorDeps` gains `containerRunning: () => Promise<boolean>`, `execVersionInContainer: () => Promise<string>`, `installedVersion: string`, `diffPromptsAndDockerfile: () => Promise<string[]>` (returns a list of filenames that differ from shipped defaults, empty if none).

- [ ] **Step 1: Write the failing tests**

```typescript
it('adds an informational notice (not a failure) on a version mismatch', async () => {
  const report = await runDoctorCommand(baseConfig, {
    collectPreflightFailures: async () => [],
    resolveGitHubToken: async () => 'tok',
    hasDockerfile: async () => false,
    dockerReachable: async () => true,
    inspectImage: async () => true,
    wakeRoot: '/tmp/wake',
    image: 'x',
    containerRunning: async () => true,
    execVersionInContainer: async () => '0.1.20',
    installedVersion: '0.1.22',
    diffPromptsAndDockerfile: async () => [],
  } as any);

  expect(report.failures).toEqual([]);
  expect(report.notices.some((n) => n.includes('0.1.20') && n.includes('0.1.22'))).toBe(true);
});

it('adds an informational notice per drifted file, never a failure', async () => {
  const report = await runDoctorCommand(baseConfig, {
    collectPreflightFailures: async () => [],
    resolveGitHubToken: async () => 'tok',
    hasDockerfile: async () => false,
    dockerReachable: async () => true,
    inspectImage: async () => true,
    wakeRoot: '/tmp/wake',
    image: 'x',
    containerRunning: async () => false,
    execVersionInContainer: async () => '',
    installedVersion: '0.1.22',
    diffPromptsAndDockerfile: async () => ['prompts/refine.md', 'docker/Dockerfile'],
  } as any);

  expect(report.failures).toEqual([]);
  expect(report.notices.some((n) => n.includes('prompts/refine.md'))).toBe(true);
  expect(report.notices.some((n) => n.includes('docker/Dockerfile'))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/doctor-command.test.ts -t "notice"`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
  if (await deps.containerRunning()) {
    const sandboxVersion = await deps.execVersionInContainer();
    if (sandboxVersion !== '' && sandboxVersion !== deps.installedVersion) {
      notices.push(
        `sandbox is running version ${sandboxVersion}, installed CLI is ${deps.installedVersion} — run \`wake sandbox build && wake sandbox update\` to sync`,
      );
    }
  }

  const driftedFiles = await deps.diffPromptsAndDockerfile();
  for (const file of driftedFiles) {
    notices.push(`${file} differs from the currently-shipped default (not auto-overwritten)`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/doctor-command.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor-command.ts test/cli/doctor-command.test.ts
git commit -m "Add version and prompt/Dockerfile drift notices to wake doctor"
```

---

### Task 5: Wire `wake doctor` into `dispatchMainCommand` with real dependencies

**Files:**

- Modify: `src/main.ts`
- Test: `test/cli/main.test.ts`

**Interfaces:**

- Consumes: `runDoctorCommand`, `DoctorDeps` from Tasks 2–4.

- [ ] **Step 1: Write the failing test**

Add to `test/cli/main.test.ts`:

```typescript
it('routes doctor to the doctor handler', async () => {
  const runDoctor = vi.fn(async () => {});

  await dispatchMainCommand({
    args: ['doctor', '--wake-root', '/tmp/wake-home'],
    runInit: async () => {},
    runSandbox: async () => {},
    runTick: async () => {},
    runStart: async () => {},
    runSmoke: async () => {},
    runUi: async () => {},
    runCorrelate: async () => {},
    execIntoSandbox: async () => {},
    runDoctor,
  } as any);

  expect(runDoctor).toHaveBeenCalledWith(['--wake-root', '/tmp/wake-home']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/main.test.ts -t "routes doctor"`
Expected: FAIL — `doctor` is not a recognized command yet.

- [ ] **Step 3: Implement**

Add `runDoctor: (args: string[]) => Promise<unknown>` to `dispatchMainCommand`'s input type, and a `doctor` branch (host-only command, alongside `init`/`sandbox`/`stop` — never auto-delegated into the sandbox, since it needs to report on sandbox reachability from the outside):

```typescript
if (command === 'doctor') {
  await input.runDoctor(input.args.slice(1));
  return;
}
```

In `main()`, wire a real `runDoctor` handler: resolve `wakeRoot`/`config` the same way `runSandbox`'s handler does, build a `DoctorDeps` object from real implementations (`resolveGitHubToken` already imported; `hasDockerfile` from the wake-home-restructure plan's Task 3; Docker reachability/image-inspection reusing `inspectDockerImage`/the `docker` client already constructed for the sandbox handler; `execVersionInContainer` via `docker.exec`-with-capture — reuse the `execCaptured` helper added in the wake-home-restructure plan's Task 5 if available, otherwise a minimal one-off capture; `diffPromptsAndDockerfile` comparing `wake-home/prompts/*.md` and `wake-home/docker/Dockerfile` byte-for-byte against the shipped copies under `resolvePackageRoot()`), call `runDoctorCommand`, then print `failures`/`notices` to the console (failures under a `Failures:` heading, notices under a `Notices:` heading) and set `process.exitCode = 1` if `failures.length > 0`.

Add `wake doctor` to the `printUsage()` command list from the CLI-help-and-container-naming plan (Task 1 there) if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/main.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/main.ts test/cli/main.test.ts
git commit -m "Wire wake doctor into the CLI with real dependencies"
```

---

### Task 6: Documentation

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add `wake doctor` to the command list and a short pointer**

Near "Getting Started", add a sentence pointing new users at `wake doctor` as the first thing to run after `wake init` and `wake sandbox build`.

- [ ] **Step 2: Verify formatting and commit**

Run: `npx prettier --check README.md`, fix with `npx prettier --write --end-of-line lf README.md` if needed, then:

```bash
git add README.md
git commit -m "Document wake doctor"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: lint, format:check, build, and test all pass (ignoring the known Windows CRLF false-positive on untouched files per `CLAUDE.md`).

- [ ] **Step 2: Commit if verify required any fixes**

```bash
git add -A
git commit -m "Fix verify failures"
```
