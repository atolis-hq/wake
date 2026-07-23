# dev.mode Packaged Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `dev.mode: "source" | "packaged"` to the config schema, decided once at `wake init`; add a second, packaged-mode Dockerfile template; make `wake sandbox build` write whichever template applies the first time `docker/Dockerfile` is missing (not `wake init` — see the revised auto-delegation design); gate `wake sandbox self-update` on `dev.mode: "source"` with a clear error otherwise.

**Architecture:** `dev.mode` detection lives in `runInitCommand`/`scaffoldWakeHome` (inspecting `repoRoot` for `src/main.ts` + `tsconfig.json`), recorded into `config.json` via the schema. The two Dockerfile templates live in the repo's own `docker/` directory (`Dockerfile`, `Dockerfile.packaged`) and are published the same way the existing `Dockerfile` already is. `runSandboxCommand`'s `build` subcommand gains a "write Dockerfile if missing" step before calling `docker.build`, choosing the template file by `config.dev.mode` and substituting the pinned CLI version into the packaged template. The `self-update` subcommand's existing `undefined`-dependency-bundle guard in `main.ts` gets one more condition.

**Tech Stack:** TypeScript, Vitest, Node `node:fs/promises`.

## Global Constraints

- `dev.mode` is `optional()` in the schema, never defaulted — an existing wake-home with no `dev.mode` reads as `undefined`, which every gate in this plan must treat identically to `'packaged'` (safe default: never assume a git checkout).
- The packaged Dockerfile template pins the exact installed CLI version (`wakeVersion` from `src/version.ts`) at scaffold/build time — never `@latest`.
- No live mode-switching command and no npm-registry-based self-update — both explicitly out of scope per the spec.
- `docker/Dockerfile` is user-owned once written — `sandbox build` must never overwrite an existing one, only write it when absent.
- Update `docs/development.md` and `README.md` per the spec's Documentation section; keep additions minimal and scoped to this change.
- Run `npm run verify` before considering the branch done (per `CLAUDE.md`).

---

### Task 1: `dev.mode` schema field

**Files:**

- Modify: `src/domain/schema.ts`
- Test: find and extend the existing schema test file covering `wakeConfigSchema` (run `grep -rln "wakeConfigSchema" test/` to locate it first)

**Interfaces:**

- Produces: `WakeConfig['dev']` gains an optional `mode: 'source' | 'packaged' | undefined` field.

- [ ] **Step 1: Write the failing test**

In the located schema test file, add:

```typescript
it('accepts dev.mode as "source" or "packaged", and leaves it undefined by default', () => {
  const withSource = parseWakeConfig({
    paths: { wakeRoot: '/tmp/wake' },
    dev: { mode: 'source' },
  });
  expect(withSource.dev?.mode).toBe('source');

  const withPackaged = parseWakeConfig({
    paths: { wakeRoot: '/tmp/wake' },
    dev: { mode: 'packaged' },
  });
  expect(withPackaged.dev?.mode).toBe('packaged');

  const withoutMode = parseWakeConfig({ paths: { wakeRoot: '/tmp/wake' } });
  expect(withoutMode.dev?.mode).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <located test file> -t "dev.mode"`
Expected: FAIL — zod rejects the unrecognized `mode` key, or `dev.mode` is `undefined`/stripped depending on the schema's `.strict()`/passthrough setting (check which).

- [ ] **Step 3: Implement the schema change**

In `src/domain/schema.ts`, locate:

```typescript
dev: z
  .object({
    repoRoot: z.string().optional(),
  })
  .default({}),
```

Change to:

```typescript
dev: z
  .object({
    repoRoot: z.string().optional(),
    mode: z.enum(['source', 'packaged']).optional(),
  })
  .default({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run <located test file>`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/domain/schema.ts <located test file>
git commit -m "Add dev.mode (source|packaged) to the config schema"
```

---

### Task 2: `wake init` detects and records `dev.mode`

**Files:**

- Modify: `src/cli/init-command.ts`
- Modify: `src/cli/scaffold-assets.ts`
- Test: `test/cli/scaffold-assets.test.ts` (and/or an `init-command.test.ts` if one exists — check with `find test/cli -iname "init-command*"`)

**Interfaces:**

- Consumes: `dev.mode` schema field from Task 1.
- Produces: `detectDevMode(repoRoot: string): Promise<'source' | 'packaged'>`, exported from `src/cli/scaffold-assets.ts`. `scaffoldWakeHome`'s input gains an optional `devModeOverride?: 'source' | 'packaged'`.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli/scaffold-assets.test.ts`:

```typescript
import { access } from 'node:fs/promises';
import { detectDevMode, scaffoldWakeHome } from '../../src/cli/scaffold-assets.js';

describe('detectDevMode', () => {
  it('returns "source" when repoRoot has src/main.ts and tsconfig.json', async () => {
    // reuse this file's existing temp-repoRoot fixture helper, which already
    // mirrors a source checkout — check what files it creates
    const mode = await detectDevMode(repoRootWithSrcCheckout);
    expect(mode).toBe('source');
  });

  it('returns "packaged" when repoRoot has no src/ or tsconfig.json', async () => {
    const mode = await detectDevMode(repoRootPublishedTreeOnly);
    expect(mode).toBe('packaged');
  });
});

it('records the detected dev.mode into config.json', async () => {
  const wakeRoot = await makeTempWakeRoot(); // match existing helper
  await scaffoldWakeHome({ wakeRoot, repoRoot: repoRootWithSrcCheckout });

  const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));
  expect(config.dev.mode).toBe('source');
});

it('honors an explicit devModeOverride regardless of repoRoot contents', async () => {
  const wakeRoot = await makeTempWakeRoot();
  await scaffoldWakeHome({
    wakeRoot,
    repoRoot: repoRootWithSrcCheckout,
    devModeOverride: 'packaged',
  });

  const config = JSON.parse(await readFile(join(wakeRoot, 'config.json'), 'utf8'));
  expect(config.dev.mode).toBe('packaged');
});
```

Adjust fixture setup to whatever pattern `scaffold-assets.test.ts` already uses for a `repoRoot` — check the file first (`grep -n "repoRoot" test/cli/scaffold-assets.test.ts`) and create two variants: one with `src/main.ts` + `tsconfig.json` written into it, one without.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli/scaffold-assets.test.ts -t "dev.mode|detectDevMode"`
Expected: FAIL — `detectDevMode` doesn't exist yet; `config.dev.mode` is `undefined`.

- [ ] **Step 3: Implement `detectDevMode` and wire it into `scaffoldWakeHome`**

In `src/cli/scaffold-assets.ts`, add (near the top, after imports — add `access` to the existing `node:fs/promises` import list rather than a duplicate import):

```typescript
export async function detectDevMode(repoRoot: string): Promise<'source' | 'packaged'> {
  try {
    await access(join(repoRoot, 'src', 'main.ts'));
    await access(join(repoRoot, 'tsconfig.json'));
    return 'source';
  } catch {
    return 'packaged';
  }
}
```

Change `scaffoldWakeHome`'s signature and body:

```typescript
export async function scaffoldWakeHome(input: {
  wakeRoot: string;
  repoRoot: string;
  devModeOverride?: 'source' | 'packaged';
}): Promise<void> {
  const wakeRoot = resolve(input.wakeRoot);
  const repoRoot = resolve(input.repoRoot);
  const devMode = input.devModeOverride ?? (await detectDevMode(repoRoot));
  const defaults = createDefaultWakeConfig(wakeRoot);
  const config = {
    ...defaults,
    sandbox: {
      ...defaults.sandbox,
      containerName: `wake-sandbox-${sanitizeContainerName(basename(wakeRoot))}`,
    },
    dev: {
      repoRoot,
      mode: devMode,
    },
  };
```

(This assumes Task 4 of the CLI-help-and-container-naming plan already landed `sanitizeContainerName`/the `sandbox.containerName` override — if executing this plan before that one, keep the pre-existing `sandbox` handling as-is and only add the `dev.mode` piece.)

In `src/cli/init-command.ts`, add `--dev`/`--packaged` override-flag parsing:

```typescript
export async function runInitCommand(input: {
  cwd: string;
  args: string[];
  repoRoot: string;
}): Promise<{ wakeRoot: string }> {
  const positionalArgs = input.args.filter((arg) => arg !== '--dev' && arg !== '--packaged');
  const wakeRoot = resolve(input.cwd, positionalArgs[0] ?? '.');
  const devModeOverride = input.args.includes('--dev')
    ? 'source'
    : input.args.includes('--packaged')
      ? 'packaged'
      : undefined;

  await assertEmptyDirectory(wakeRoot);
  await scaffoldWakeHome({
    wakeRoot,
    repoRoot: input.repoRoot,
    ...(devModeOverride === undefined ? {} : { devModeOverride }),
  });

  return { wakeRoot };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli/scaffold-assets.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/cli/scaffold-assets.ts src/cli/init-command.ts test/cli/scaffold-assets.test.ts
git commit -m "wake init detects and records dev.mode, with --dev/--packaged override flags"
```

---

### Task 3: Packaged-mode Dockerfile template

**Files:**

- Create: `docker/Dockerfile.packaged`

Confirmed: `package.json`'s `"files"` array already lists `"docker"` as a whole directory (not individual files), so no `package.json` change is needed — the new template is published automatically.

The existing `docker/Dockerfile` installs `git openssh-client ca-certificates curl gnupg`, then adds the `gh` and `ngrok` apt repos and installs those, then `npm install -g @anthropic-ai/claude-code @openai/codex`, creates a non-root `wake` user, installs the Cursor CLI, then `COPY`s and builds the source and runs as `USER wake` with `ENTRYPOINT ["/app/docker/entrypoint.sh"]`. The packaged template needs the same runtime tooling (git/ssh/gh/ngrok/claude/codex/cursor CLIs, non-root `wake` user) but skips the `COPY package*.json` / `npm ci` / `npm run build` source-compile steps, replacing them with one `npm install -g @atolis-hq/wake@<version>`.

- [ ] **Step 1: Write the template**

Create `docker/Dockerfile.packaged`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
    | gpg --dearmor -o /etc/apt/keyrings/ngrok-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/ngrok-archive-keyring.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/ngrok-archive-keyring.gpg] https://ngrok-agent.s3.amazonaws.com buster main" \
    > /etc/apt/sources.list.d/ngrok.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh ngrok

ARG WAKE_VERSION
RUN test -n "$WAKE_VERSION" || (echo "WAKE_VERSION build arg is required" && exit 1)

RUN --mount=type=cache,target=/root/.npm \
  npm install -g @anthropic-ai/claude-code @openai/codex "@atolis-hq/wake@${WAKE_VERSION}"

RUN useradd --create-home --shell /bin/bash wake \
  && mkdir -p /home/wake/.codex-runtime \
  && mkdir -p /home/wake/.cursor \
  && chown -R wake:wake /home/wake/.codex-runtime \
  && chown -R wake:wake /home/wake/.cursor

ENV CODEX_HOME=/home/wake/.codex-runtime
ENV PATH=/home/wake/.local/bin:$PATH

RUN curl https://cursor.com/install -fsS | HOME=/home/wake bash \
  && printf '#!/bin/bash\n[ "$1" = "agent" ] && shift\nexec ~/.local/bin/agent "$@"\n' \
     > /home/wake/.local/bin/cursor \
  && chmod +x /home/wake/.local/bin/cursor \
  && chown -R wake:wake /home/wake/.local

USER wake
WORKDIR /home/wake

EXPOSE 4317

ENTRYPOINT ["node", "/usr/lib/node_modules/@atolis-hq/wake/dist/src/main.js", "sandbox-entrypoint"]
```

The `ENTRYPOINT` here uses the `wake sandbox-entrypoint` subcommand that the wake-home-restructure plan introduces. If this plan (dev-mode-packaged-builds) is executed **before** that subcommand exists, this `ENTRYPOINT` will fail at container start — that is expected and acceptable: this plan's own tests only exercise `ensureDockerfile`'s file-writing logic (Task 4) and never actually run `docker build`/`docker run` against this template, so the missing subcommand doesn't block this plan's own verification. Note it in your final report to the user as a known follow-on dependency.

- [ ] **Step 2: Commit**

```bash
git add docker/Dockerfile.packaged
git commit -m "Add packaged-mode Dockerfile template"
```

---

### Task 4: `wake sandbox build` writes the Dockerfile lazily from the correct template

**Files:**

- Modify: `src/cli/sandbox-command.ts`
- Test: `test/cli/sandbox-command.test.ts` (check exact filename with `find test/cli -iname "sandbox-command*"`)

**Interfaces:**

- Consumes: `config.dev.mode` from Task 1, `docker/Dockerfile.packaged` from Task 3.
- Produces: a non-exported `ensureDockerfile(input)` helper inside `sandbox-command.ts`, called from the `build` subcommand branch.

- [ ] **Step 1: Read the existing `build` subcommand code and test fixtures**

Run: `sed -n '85,101p' src/cli/sandbox-command.ts` and open `test/cli/sandbox-command.test.ts` to see how `runSandboxCommand`'s `docker`/filesystem dependencies are faked in existing tests (it likely takes injected `docker: { build, up, ... }` functions — check whether file I/O is real (temp dir) or also injected).

- [ ] **Step 2: Write the failing tests**

Add to `test/cli/sandbox-command.test.ts`, matching whatever fixture pattern (temp `wakeRoot`, injected `docker.build` spy) the file already uses:

```typescript
it('writes docker/Dockerfile from the source template when missing and dev.mode is "source"', async () => {
  const wakeRoot = await makeTempWakeRoot(); // match existing helper
  const dockerBuild = vi.fn(async () => {});

  await runSandboxCommand({
    args: ['build'],
    config: { ...baseConfig, dev: { repoRoot: '/repo', mode: 'source' } },
    wakeRoot,
    // ...other required fields, matching existing test setup
    docker: { ...fakeDocker, build: dockerBuild },
  });

  const written = await readFile(join(wakeRoot, 'docker', 'Dockerfile'), 'utf8');
  expect(written).toContain('npm run build');
  expect(dockerBuild).toHaveBeenCalled();
});

it('writes docker/Dockerfile from the packaged template when missing and dev.mode is "packaged"', async () => {
  const wakeRoot = await makeTempWakeRoot();

  await runSandboxCommand({
    args: ['build'],
    config: { ...baseConfig, dev: { repoRoot: '/repo', mode: 'packaged' } },
    wakeRoot,
    docker: fakeDocker,
  });

  const written = await readFile(join(wakeRoot, 'docker', 'Dockerfile'), 'utf8');
  expect(written).toContain('npm install -g "@atolis-hq/wake@');
});

it('leaves an existing docker/Dockerfile untouched on a second build', async () => {
  const wakeRoot = await makeTempWakeRoot();
  await mkdir(join(wakeRoot, 'docker'), { recursive: true });
  await writeFile(join(wakeRoot, 'docker', 'Dockerfile'), 'CUSTOM CONTENT', 'utf8');

  await runSandboxCommand({
    args: ['build'],
    config: { ...baseConfig, dev: { repoRoot: '/repo', mode: 'packaged' } },
    wakeRoot,
    docker: fakeDocker,
  });

  const written = await readFile(join(wakeRoot, 'docker', 'Dockerfile'), 'utf8');
  expect(written).toBe('CUSTOM CONTENT');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/cli/sandbox-command.test.ts -t "Dockerfile"`
Expected: FAIL — `build` today assumes `docker/Dockerfile` already exists and never writes one.

- [ ] **Step 4: Add `buildArgs` support to `DockerBuildInput`/`createDockerCli().build`**

Confirmed current shape in `src/adapters/docker/docker-cli.ts`:

```typescript
export type DockerBuildInput = {
  image: string;
  dockerfile: string;
  contextDir: string;
};
```

and:

```typescript
async build(input: DockerBuildInput): Promise<void> {
  await deps.run(['build', '-t', input.image, '-f', input.dockerfile, input.contextDir]);
},
```

Change to:

```typescript
export type DockerBuildInput = {
  image: string;
  dockerfile: string;
  contextDir: string;
  buildArgs?: Record<string, string>;
};
```

```typescript
async build(input: DockerBuildInput): Promise<void> {
  const buildArgFlags = Object.entries(input.buildArgs ?? {}).flatMap(([key, value]) => [
    '--build-arg',
    `${key}=${value}`,
  ]);
  await deps.run([
    'build',
    '-t',
    input.image,
    '-f',
    input.dockerfile,
    ...buildArgFlags,
    input.contextDir,
  ]);
},
```

Check `test/adapters/docker-cli.test.ts` (or wherever this file's tests live — `find test -iname "docker-cli*"`) for existing `build` assertions and add one confirming `buildArgs` are passed as `--build-arg KEY=value` pairs before the context dir argument, and that omitting `buildArgs` produces the exact same `deps.run` call as before this change (no regression to the no-args case).

- [ ] **Step 5: Implement `ensureDockerfile` and wire it into `build`**

In `src/cli/sandbox-command.ts`, extend the existing `node:fs/promises` import with `access`, `readFile`, `writeFile` (do not add a duplicate import line), and add an import for `wakeVersion` from `../version.js`. Add a new required field to `runSandboxCommand`'s `input` type: `packagedTemplatesRoot: string` (the directory containing the shipped `Dockerfile`/`Dockerfile.packaged` templates — at the `main.ts` call site this is wired as `resolve(resolvePackageRoot(), 'docker')`, using the same `resolvePackageRoot()` helper already defined in `main.ts` at line 58).

```typescript
async function ensureDockerfile(input: {
  wakeRoot: string;
  devMode: 'source' | 'packaged' | undefined;
  packagedTemplatesRoot: string;
}): Promise<void> {
  const targetPath = resolve(input.wakeRoot, 'docker', 'Dockerfile');

  try {
    await access(targetPath);
    return; // already present — user-owned, never overwritten
  } catch {
    // fall through to write it
  }

  const mode = input.devMode ?? 'packaged';
  const templatePath = resolve(
    input.packagedTemplatesRoot,
    mode === 'source' ? 'Dockerfile' : 'Dockerfile.packaged',
  );
  const content = await readFile(templatePath, 'utf8');

  await mkdir(resolve(input.wakeRoot, 'docker'), { recursive: true });
  await writeFile(targetPath, content, 'utf8');
}
```

Note this writes the template verbatim — the `Dockerfile.packaged` template from Task 3 declares `ARG WAKE_VERSION` and expects it supplied at `docker build` time via `--build-arg`, not string-substituted into the file. That's what Step 4's `buildArgs` plumbing is for.

Locate the `build` subcommand branch (around line 89) and change:

```typescript
if (subcommand === 'build') {
  const repoRoot = input.config.dev?.repoRoot;
  if (repoRoot === undefined || repoRoot.length === 0) {
    throw new Error('Sandbox build requires config.dev.repoRoot');
  }

  await input.docker.build({
    image: input.config.sandbox.image,
    dockerfile: resolve(input.wakeRoot, 'docker', 'Dockerfile'),
    contextDir: repoRoot,
  });
  return;
}
```

to:

```typescript
if (subcommand === 'build') {
  const repoRoot = input.config.dev?.repoRoot;
  if (repoRoot === undefined || repoRoot.length === 0) {
    throw new Error('Sandbox build requires config.dev.repoRoot');
  }

  await ensureDockerfile({
    wakeRoot: input.wakeRoot,
    devMode: input.config.dev?.mode,
    packagedTemplatesRoot: input.packagedTemplatesRoot,
  });

  await input.docker.build({
    image: input.config.sandbox.image,
    dockerfile: resolve(input.wakeRoot, 'docker', 'Dockerfile'),
    contextDir: repoRoot,
    ...(input.config.dev?.mode === 'packaged' ? { buildArgs: { WAKE_VERSION: wakeVersion } } : {}),
  });
  return;
}
```

Add `packagedTemplatesRoot: string` to `runSandboxCommand`'s `input` type. In `main.ts`, find the `runSandbox` call site (around line 577, the `async (commandArgs) => { ... }` handler passed to `dispatchMainCommand`) and pass `packagedTemplatesRoot: resolve(resolvePackageRoot(), 'docker')` alongside the other fields already being passed into `runSandboxCommand`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/cli/sandbox-command.test.ts test/adapters/docker-cli.test.ts`
Expected: PASS (both files)

- [ ] **Step 7: Commit**

```bash
git add src/cli/sandbox-command.ts src/adapters/docker/docker-cli.ts src/main.ts test/cli/sandbox-command.test.ts
git commit -m "wake sandbox build writes docker/Dockerfile from the dev.mode template when absent"
```

---

### Task 5: Gate `wake sandbox self-update` on `dev.mode: "source"`

**Files:**

- Modify: `src/main.ts`
- Modify: `src/cli/sandbox-command.ts`
- Test: `test/cli/sandbox-command.test.ts`

**Interfaces:**

- Consumes: `config.dev.mode` from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `test/cli/sandbox-command.test.ts`:

```typescript
it('throws a dev.mode-specific error for self-update when selfUpdate deps are undefined', async () => {
  await expect(
    runSandboxCommand({
      args: ['self-update'],
      config: { ...baseConfig, dev: { repoRoot: '/repo', mode: 'packaged' } },
      wakeRoot: '/tmp/whatever',
      docker: fakeDocker,
      selfUpdate: undefined,
      // ...other required fields matching existing test setup
    }),
  ).rejects.toThrow(/dev\.mode: "source"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/sandbox-command.test.ts -t "dev.mode-specific"`
Expected: FAIL — current message is the generic `Sandbox self-update requires git/issueReporter/ledger dependencies`.

- [ ] **Step 3: Update the error message in `sandbox-command.ts`**

Locate (around line 165):

```typescript
if (input.selfUpdate === undefined) {
  throw new Error('Sandbox self-update requires git/issueReporter/ledger dependencies');
}
```

Change to:

```typescript
if (input.selfUpdate === undefined) {
  throw new Error(
    'Sandbox self-update requires dev.mode: "source". For a packaged install, update instead with:\n' +
      '  npm install -g @atolis-hq/wake@latest && wake sandbox build && wake sandbox update',
  );
}
```

- [ ] **Step 4: Gate the `selfUpdate` dependency-bundle construction in `main.ts` on `dev.mode`**

Locate (around line 598):

```typescript
const repoRoot = config.dev?.repoRoot;
const selfUpdate =
  commandArgs[0] === 'self-update' && repoRoot !== undefined && repoRoot.length > 0
    ? {
```

Change the condition to:

```typescript
const repoRoot = config.dev?.repoRoot;
const selfUpdate =
  commandArgs[0] === 'self-update' &&
  config.dev?.mode === 'source' &&
  repoRoot !== undefined &&
  repoRoot.length > 0
    ? {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cli/sandbox-command.test.ts`
Expected: PASS (full file)

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/cli/sandbox-command.ts test/cli/sandbox-command.test.ts
git commit -m "Gate wake sandbox self-update on dev.mode: source with a clear packaged-mode error"
```

---

### Task 6: Documentation

**Files:**

- Modify: `docs/development.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/development.md`**

In the dev-checkout workflow section, add a short paragraph noting this workflow corresponds to `dev.mode: "source"` (auto-detected by `wake init` when run from a full source checkout) and that `wake sandbox self-update` is unavailable outside it.

- [ ] **Step 2: `README.md`**

In "Getting Started", add one sentence noting `wake init` auto-detects packaged vs. source mode, so `wake sandbox build` works out of the box for a plain `npm install -g` install.

- [ ] **Step 3: Verify formatting and commit**

Run: `npx prettier --check docs/development.md README.md`, fix with `npx prettier --write --end-of-line lf <file>` if needed, then:

```bash
git add docs/development.md README.md
git commit -m "Document dev.mode auto-detection"
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
