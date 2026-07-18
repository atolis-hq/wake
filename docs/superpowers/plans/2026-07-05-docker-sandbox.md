# Docker Sandbox Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scaffolded Wake home layout and Docker-backed sandbox commands so Wake's control plane can run inside one durable container while keeping config, prompts, auth state, and workspaces on the host-mounted home directory.

**Architecture:** Keep the current tick runner and adapter graph intact, and add a thin CLI layer around it. `wake init` will scaffold a self-contained home directory by copying repo-owned defaults and assets, while `wake sandbox ...` delegates Docker command construction to a dedicated adapter that can be unit tested without Docker. Prompt loading and config parsing become sandbox-aware through explicit config fields instead of hardcoded repo-relative lookup.

**Tech Stack:** Node.js, TypeScript, Vitest, Zod, Docker, Bash

---

## File Structure

- `docker/Dockerfile`
  Builds the Wake runtime image from the repo checkout and starts the resident control plane from `dist/src/main.js`.
- `docker/setup.sh`
  Documents and automates the first-run interactive auth flow inside the running container.
- `src/cli/init-command.ts`
  Implements `wake init [dir]` and owns target-directory validation plus scaffold orchestration.
- `src/cli/scaffold-assets.ts`
  Copies config defaults, prompt templates, Docker assets, and runtime directories into a new Wake home.
- `src/cli/sandbox-command.ts`
  Handles `wake sandbox build|up|down|setup|exec|resume` argument parsing and dispatch.
- `src/cli/sandbox-resume.ts`
  Resolves explicit `sessionId` / `--cwd` input and the no-arg "pick latest workspace/run" flow.
- `src/adapters/docker/docker-cli.ts`
  Wraps `docker build`, `docker run`, `docker start`, `docker stop`, and `docker exec` argument construction behind a testable boundary.
- `src/adapters/claude/prompt-templates.ts`
  Loads prompt templates from `config.paths.promptsRoot` when present, falling back to the current repo-relative lookup.
- `src/config/defaults.ts`
  Produces the scaffolded config defaults, including `paths.promptsRoot` and the new `sandbox` section.
- `src/config/load-config.ts`
  Deep-merges sandbox and prompt-path config from `config.json`.
- `src/domain/schema.ts`
  Extends `WakeConfig` validation with optional `paths.promptsRoot` and required `sandbox` fields.
- `src/main.ts`
  Routes the new CLI surface while preserving `tick`, `start`, and `smoke claude`.
- `src/adapters/github/github-issues-work-source.ts`
  Updates the human resume instructions to point at `wake sandbox resume ...` when a session and workspace path are available.
- `test/domain/schema.test.ts`
  Covers config schema additions.
- `test/adapters/prompt-templates.test.ts`
  Covers prompt-root override behavior and the current fallback.
- `test/adapters/docker-cli.test.ts`
  Verifies `docker` subcommand arguments without requiring a Docker daemon.
- `test/cli/init-command.test.ts`
  Covers scaffold layout and copied assets.
- `test/cli/sandbox-command.test.ts`
  Covers build/up/down/setup/exec command dispatch.
- `test/cli/sandbox-resume.test.ts`
  Covers explicit resume and no-arg workspace/run discovery.
- `test/cli/main.test.ts`
  Verifies the top-level CLI routes new commands correctly.
- `test/adapters/github-issues-work-source.test.ts`
  Verifies published Wake comments advertise the sandbox-aware resume command.

### Task 1: Extend Wake config and prompt loading for sandbox-aware homes

**Files:**
- Modify: `src/domain/schema.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/load-config.ts`
- Modify: `src/adapters/claude/prompt-templates.ts`
- Modify: `test/domain/schema.test.ts`
- Modify: `test/adapters/prompt-templates.test.ts`

- [ ] **Step 1: Write the failing config and prompt-root tests**

```ts
it('accepts sandbox configuration and an explicit prompts root', () => {
  const config = parseWakeConfig({
    schemaVersion: 1,
    paths: {
      wakeRoot: '/tmp/wake-home',
      promptsRoot: '/tmp/wake-home/prompts',
    },
    sandbox: {
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
    },
    scheduler: {
      intervalMs: 1000,
    },
    runner: {
      mode: 'fake',
      claude: {
        command: 'claude',
        model: 'haiku',
        smokeModel: 'haiku',
        sessionName: 'Wake',
        remoteControlName: 'Wake',
        smokePrompt: 'hi',
        remoteControl: {
          enabled: false,
        },
      },
    },
    sources: {
      github: {
        enabled: false,
        repos: [],
        polling: {
          maxIssuesPerRepo: 25,
          commentPageSize: 25,
          lookbackMs: 60000,
        },
        policy: {
          requiredLabels: [],
          ignoredLabels: [],
        },
        publication: {
          postStatusComments: true,
        },
      },
    },
  });

  expect(config.paths.promptsRoot).toBe('/tmp/wake-home/prompts');
  expect(config.sandbox.containerName).toBe('wake-sandbox');
});
```

```ts
it('loads templates from an explicit prompts root before falling back to repo prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
  const promptsDir = join(root, 'prompts');
  await mkdir(promptsDir, { recursive: true });
  await writeFile(
    join(promptsDir, 'refine.start.md'),
    ['---', 'stage: refine', 'mode: start', '---', 'Custom {{title}}'].join('\n'),
    'utf8',
  );

  const template = await loadPromptTemplate('refine', 'start', { promptsRoot: promptsDir });
  expect(template.body).toContain('Custom {{title}}');
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run test/domain/schema.test.ts test/adapters/prompt-templates.test.ts`

Expected: FAIL with schema errors for the missing `sandbox` block and type errors because `loadPromptTemplate` does not yet accept a `promptsRoot` option.

- [ ] **Step 3: Write the minimal sandbox-aware config and prompt lookup changes**

```ts
paths: z.object({
  wakeRoot: z.string(),
  promptsRoot: z.string().optional(),
}),
sandbox: z.object({
  image: z.string().min(1),
  containerName: z.string().min(1),
  containerMountPath: z.string().min(1),
  containerHomeMountPath: z.string().min(1),
}),
```

```ts
export function createDefaultWakeConfig(
  wakeRoot = resolve(process.cwd(), '.wake'),
): WakeConfig {
  return parseWakeConfig({
    schemaVersion: 1,
    paths: {
      wakeRoot,
      promptsRoot: resolve(wakeRoot, 'prompts'),
    },
    sandbox: {
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
    },
    scheduler: {
      intervalMs: 30 * 60 * 1000,
    },
    runner: {
      mode: 'fake',
      claude: {
        command: 'claude',
        model: 'haiku',
        smokeModel: 'haiku',
        sessionName: 'Wake',
        remoteControlName: 'Wake',
        smokePrompt: defaultSmokePrompt,
        remoteControl: {
          enabled: false,
        },
      },
    },
    sources: {
      github: {
        enabled: false,
        repos: [],
        polling: {
          maxIssuesPerRepo: 25,
          commentPageSize: 25,
          lookbackMs: 60_000,
        },
        policy: {
          requiredLabels: [],
          ignoredLabels: [],
        },
        publication: {
          postStatusComments: true,
        },
      },
    },
  });
}
```

```ts
export function promptsRoot(explicitRoot?: string): string {
  if (explicitRoot !== undefined) {
    return explicitRoot;
  }

  return join(findProjectRoot(dirname(fileURLToPath(import.meta.url))), 'prompts');
}

export async function loadPromptTemplate(
  stage: string,
  mode: string,
  options?: { promptsRoot?: string },
): Promise<PromptTemplate> {
  const filePath = join(promptsRoot(options?.promptsRoot), `${stage}.${mode}.md`);
  const raw = await readFile(filePath, 'utf8');
  return parseFrontmatter(raw);
}
```

Thread `input.config.paths.promptsRoot` through `buildStagePrompt()` in `src/adapters/claude/claude-runner.ts` after this task's tests are green.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `npx vitest run test/domain/schema.test.ts test/adapters/prompt-templates.test.ts test/adapters/claude-runner.test.ts`

Expected: PASS, including the existing Claude-runner suite after the prompt-loading signature change.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schema.ts src/domain/types.ts src/config/defaults.ts src/config/load-config.ts src/adapters/claude/prompt-templates.ts src/adapters/claude/claude-runner.ts test/domain/schema.test.ts test/adapters/prompt-templates.test.ts test/adapters/claude-runner.test.ts
git commit -m "feat: add sandbox-aware wake config and prompt roots"
```

### Task 2: Add scaffold assets and implement `wake init`

**Files:**
- Create: `docker/Dockerfile`
- Create: `docker/setup.sh`
- Create: `src/cli/scaffold-assets.ts`
- Create: `src/cli/init-command.ts`
- Create: `test/cli/init-command.test.ts`
- Modify: `src/lib/paths.ts`

- [ ] **Step 1: Write the failing scaffold tests**

```ts
it('scaffolds a self-contained wake home with config, prompts, docker assets, and runtime directories', async () => {
  const repoRoot = process.cwd();
  const targetRoot = await mkdtemp(join(tmpdir(), 'wake-init-'));
  const homeDir = join(targetRoot, 'sandbox-home');

  await runInitCommand({
    cwd: targetRoot,
    args: [homeDir],
    repoRoot,
  });

  await expect(readFile(join(homeDir, 'config.json'), 'utf8')).resolves.toContain('"sandbox"');
  await expect(readFile(join(homeDir, 'docker', 'Dockerfile'), 'utf8')).resolves.toContain('node dist/src/main.js start');
  await expect(readFile(join(homeDir, 'docker', 'setup.sh'), 'utf8')).resolves.toContain('gh auth login');
  await expect(readFile(join(homeDir, 'prompts', 'refine.start.md'), 'utf8')).resolves.toContain('stage: refine');
  await expect(access(join(homeDir, 'workspaces'))).resolves.toBeUndefined();
});
```

```ts
it('refuses to scaffold into a non-empty directory', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'wake-init-existing-'));
  await writeFile(join(targetRoot, 'notes.txt'), 'occupied', 'utf8');

  await expect(
    runInitCommand({
      cwd: targetRoot,
      args: [],
      repoRoot: process.cwd(),
    }),
  ).rejects.toThrow(/empty directory/i);
});
```

- [ ] **Step 2: Run the init tests to verify they fail**

Run: `npx vitest run test/cli/init-command.test.ts`

Expected: FAIL because the init command and scaffold helper modules do not exist yet.

- [ ] **Step 3: Write the minimal scaffold implementation**

```dockerfile
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && npm install -g @anthropic-ai/claude-code \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

RUN useradd --create-home --shell /bin/bash wake
USER wake
WORKDIR /home/wake

ENTRYPOINT ["node", "/app/dist/src/main.js", "start", "--wake-root", "/wake"]
```

```bash
#!/usr/bin/env bash
set -euo pipefail

container_name="${1:-wake-sandbox}"

docker exec -it "$container_name" gh auth login
docker exec -it "$container_name" gh auth setup-git

if ! docker exec "$container_name" test -f /home/wake/.ssh/id_ed25519; then
  docker exec -it "$container_name" ssh-keygen -t ed25519 -f /home/wake/.ssh/id_ed25519 -N ""
fi

docker exec "$container_name" cat /home/wake/.ssh/id_ed25519.pub
docker exec -it "$container_name" claude setup-token
```

```ts
export async function runInitCommand(input: {
  cwd: string;
  args: string[];
  repoRoot: string;
}): Promise<{ wakeRoot: string }> {
  const wakeRoot = resolve(input.cwd, input.args[0] ?? '.');
  await assertEmptyDirectory(wakeRoot);
  await scaffoldWakeHome({ wakeRoot, repoRoot: input.repoRoot });
  return { wakeRoot };
}
```

Copy these files from the repo into the scaffolded home:

```ts
const runtimeDirs = ['events', 'state', 'runs', 'workspaces', 'repos', 'sources', 'locks'];
const promptFiles = ['refine.start.md', 'refine.resume.md', 'implement.start.md', 'implement.resume.md'];
const dockerAssets = ['Dockerfile', 'setup.sh'];
```

Add `containerHomeRoot: join(wakeRoot, 'container-home')` to `createWakePaths()` so later tasks can reuse one canonical path for the bind-mounted home directory.

- [ ] **Step 4: Run the init tests to verify they pass**

Run: `npx vitest run test/cli/init-command.test.ts test/adapters/state-store.test.ts`

Expected: PASS, and the existing state-store tests still pass after the path helper extension.

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile docker/setup.sh src/cli/scaffold-assets.ts src/cli/init-command.ts src/lib/paths.ts test/cli/init-command.test.ts
git commit -m "feat: add wake home scaffolding"
```

### Task 3: Add a Docker adapter and implement build/up/down/setup/exec lifecycle commands

**Files:**
- Create: `src/adapters/docker/docker-cli.ts`
- Create: `src/cli/sandbox-command.ts`
- Create: `test/adapters/docker-cli.test.ts`
- Create: `test/cli/sandbox-command.test.ts`

- [ ] **Step 1: Write the failing Docker argument tests**

```ts
it('builds the sandbox image from the repo root dockerfile', async () => {
  const calls: Array<{ args: string[] }> = [];
  const docker = createDockerCli({
    run: async (args) => {
      calls.push({ args });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await docker.build({
    image: 'wake-sandbox',
    dockerfile: 'docker/Dockerfile',
    contextDir: '/repo/wake',
  });

  expect(calls[0]?.args).toEqual([
    'build',
    '-t',
    'wake-sandbox',
    '-f',
    'docker/Dockerfile',
    '/repo/wake',
  ]);
});
```

```ts
it('creates the persistent container with wake-root and container-home bind mounts', async () => {
  const calls: Array<{ args: string[] }> = [];
  const docker = createDockerCli({
    run: async (args) => {
      calls.push({ args });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    inspectImage: async () => true,
    inspectContainer: async () => null,
  });

  await docker.up({
    image: 'wake-sandbox',
    containerName: 'wake-sandbox',
    wakeRoot: '/host/wake-home',
    containerHomeRoot: '/host/wake-home/container-home',
    containerMountPath: '/wake',
    containerHomeMountPath: '/home/wake',
  });

  expect(calls.at(-1)?.args).toEqual([
    'run',
    '-d',
    '--name',
    'wake-sandbox',
    '-v',
    '/host/wake-home:/wake',
    '-v',
    '/host/wake-home/container-home:/home/wake',
    'wake-sandbox',
  ]);
});
```

- [ ] **Step 2: Run the Docker-focused tests to verify they fail**

Run: `npx vitest run test/adapters/docker-cli.test.ts test/cli/sandbox-command.test.ts`

Expected: FAIL because the Docker adapter and sandbox command module do not exist yet.

- [ ] **Step 3: Write the minimal Docker adapter and command dispatch**

```ts
export function createDockerCli(deps: {
  run: (args: string[], options?: { interactive?: boolean }) => Promise<CommandResult>;
  inspectImage: (image: string) => Promise<boolean>;
  inspectContainer: (name: string) => Promise<'running' | 'stopped' | null>;
}) {
  return {
    async build(input: { image: string; dockerfile: string; contextDir: string }) {
      return deps.run(['build', '-t', input.image, '-f', input.dockerfile, input.contextDir]);
    },
    async up(input: {
      image: string;
      containerName: string;
      wakeRoot: string;
      containerHomeRoot: string;
      containerMountPath: string;
      containerHomeMountPath: string;
    }) {
      if (!(await deps.inspectImage(input.image))) {
        throw new Error('Sandbox image not found. Run `wake sandbox build` first.');
      }

      const state = await deps.inspectContainer(input.containerName);
      if (state === 'running') {
        return;
      }
      if (state === 'stopped') {
        await deps.run(['start', input.containerName]);
        return;
      }

      await deps.run([
        'run',
        '-d',
        '--name',
        input.containerName,
        '-v',
        `${input.wakeRoot}:${input.containerMountPath}`,
        '-v',
        `${input.containerHomeRoot}:${input.containerHomeMountPath}`,
        input.image,
      ]);
    },
    down: (containerName: string) => deps.run(['stop', containerName]),
    setup: (containerName: string) => deps.run(['exec', '-it', containerName, 'bash', '/wake/docker/setup.sh'], { interactive: true }),
    exec: (containerName: string, command: string[]) =>
      deps.run(['exec', '-it', containerName, ...(command.length > 0 ? command : ['bash'])], {
        interactive: true,
      }),
  };
}
```

```ts
if (subcommand === 'build') {
  await docker.build({
    image: config.sandbox.image,
    dockerfile: resolve(repoRoot, 'docker', 'Dockerfile'),
    contextDir: repoRoot,
  });
}
```

Keep command parsing small and explicit:

```ts
const subcommand = args[0];
if (!['build', 'up', 'down', 'setup', 'exec', 'resume'].includes(subcommand ?? '')) {
  throw new Error(`Unknown sandbox command: ${subcommand ?? '(missing)'}`);
}
```

- [ ] **Step 4: Run the Docker-focused tests to verify they pass**

Run: `npx vitest run test/adapters/docker-cli.test.ts test/cli/sandbox-command.test.ts`

Expected: PASS, with no Docker daemon required.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/docker/docker-cli.ts src/cli/sandbox-command.ts test/adapters/docker-cli.test.ts test/cli/sandbox-command.test.ts
git commit -m "feat: add wake sandbox docker lifecycle commands"
```

### Task 4: Implement `wake sandbox resume` with explicit and discovery-based flows

**Files:**
- Create: `src/cli/sandbox-resume.ts`
- Create: `test/cli/sandbox-resume.test.ts`
- Modify: `src/adapters/fs/state-store.ts`

- [ ] **Step 1: Write the failing resume tests**

```ts
it('execs claude resume inside the container when sessionId and --cwd are provided', async () => {
  const calls: Array<{ args: string[] }> = [];
  const docker = createDockerCli({
    run: async (args) => {
      calls.push({ args });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    inspectImage: async () => true,
    inspectContainer: async () => 'running',
  });

  await runSandboxResumeCommand({
    args: ['session-123', '--cwd', '/wake/workspaces/atolis-hq__wake/12'],
    config: createDefaultWakeConfig('/wake-home'),
    docker,
    wakeRoot: '/wake-home',
  });

  expect(calls.at(-1)?.args).toEqual([
    'exec',
    '-it',
    'wake-sandbox',
    'bash',
    '-lc',
    'cd "/wake/workspaces/atolis-hq__wake/12" && claude --resume session-123',
  ]);
});
```

```ts
it('prompts with recent workspace-backed sessions when no args are supplied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-resume-'));
  const store = createStateStore({ wakeRoot: root });

  await store.writeRunRecord({
    schemaVersion: 1,
    runId: 'run-22',
    repo: 'atolis-hq/wake',
    issueNumber: 22,
    action: 'implement',
    status: 'completed',
    startedAt: '2026-07-05T12:00:00.000Z',
    finishedAt: '2026-07-05T12:30:00.000Z',
    sessionId: 'session-22',
  });

  await mkdir(join(root, 'workspaces', 'atolis-hq__wake', '22'), { recursive: true });

  const prompts: string[] = [];
  const selection = await chooseResumeTarget({
    wakeRoot: root,
    select: async (options) => {
      prompts.push(options.map((option) => option.label).join('\n'));
      return options[0] ?? null;
    },
  });

  expect(prompts[0]).toContain('atolis-hq/wake#22');
  expect(selection?.sessionId).toBe('session-22');
});
```

- [ ] **Step 2: Run the resume tests to verify they fail**

Run: `npx vitest run test/cli/sandbox-resume.test.ts`

Expected: FAIL because the resume command and discovery helper do not exist yet.

- [ ] **Step 3: Write the minimal resume discovery implementation**

```ts
export async function listRunRecords(wakeRoot: string): Promise<RunRecord[]> {
  const runDir = join(wakeRoot, 'runs');
  try {
    const files = (await readdir(runDir)).filter((name) => name.endsWith('.json')).sort();
    return Promise.all(
      files.map(async (file) => parseRunRecord(await readJsonFile(join(runDir, file)))),
    );
  } catch {
    return [];
  }
}
```

```ts
export async function chooseResumeTarget(input: {
  wakeRoot: string;
  select: (options: Array<{
    label: string;
    sessionId: string;
    workspacePath: string;
  }>) => Promise<{
    label: string;
    sessionId: string;
    workspacePath: string;
  } | null>;
}): Promise<{
  sessionId: string;
  workspacePath: string;
} | null> {
  const runs = await listRunRecords(wakeRoot);
  const options = runs
    .filter((run) => run.sessionId !== undefined)
    .sort((left, right) => (right.finishedAt ?? right.startedAt).localeCompare(left.finishedAt ?? left.startedAt))
    .map((run) => ({
      label: `${run.repo}#${run.issueNumber} · ${run.action} · ${run.finishedAt ?? run.startedAt}`,
      sessionId: run.sessionId as string,
      workspacePath: join(
        wakeRoot,
        'workspaces',
        run.repo.replace(/[\\/]/g, '__'),
        String(run.issueNumber),
      ),
    }));

  if (options.length === 0) {
    return null;
  }

  const selection = await input.select(options);
  return selection === null
    ? null
    : {
        sessionId: selection.sessionId,
        workspacePath: selection.workspacePath,
      };
}
```

```ts
const command = `cd "${target.workspacePath}" && claude --resume ${target.sessionId}`;
await docker.exec(config.sandbox.containerName, ['bash', '-lc', command]);
```

Back the real CLI flow with a TTY selector that prints numbered choices and reads one line from `stdin`, for example:

```ts
const selected = await chooseResumeTarget({
  wakeRoot,
  select: async (options) => {
    options.forEach((option, index) => {
      process.stdout.write(`${index + 1}. ${option.label}\n`);
    });
    process.stdout.write('Choose session: ');
    const answer = await readSingleLine(process.stdin);
    const index = Number.parseInt(answer, 10) - 1;
    return options[index] ?? null;
  },
});
```

- [ ] **Step 4: Run the resume tests to verify they pass**

Run: `npx vitest run test/cli/sandbox-resume.test.ts test/adapters/state-store.test.ts`

Expected: PASS, and existing state-store behavior remains intact after adding run listing support.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sandbox-resume.ts src/adapters/fs/state-store.ts test/cli/sandbox-resume.test.ts
git commit -m "feat: add wake sandbox resume flow"
```

### Task 5: Route the new CLI surface through `src/main.ts` and align Wake's published resume instructions

**Files:**
- Modify: `src/main.ts`
- Modify: `src/adapters/github/github-issues-work-source.ts`
- Create: `test/cli/main.test.ts`
- Modify: `test/adapters/github-issues-work-source.test.ts`

- [ ] **Step 1: Write the failing CLI routing and comment-format tests**

```ts
it('routes `wake init` to the init command and `wake sandbox up` to the sandbox command', async () => {
  const calls: string[] = [];

  await dispatchMainCommand({
    args: ['init', '/tmp/wake-home'],
    runInit: async () => {
      calls.push('init');
    },
    runSandbox: async () => {
      calls.push('sandbox');
    },
    runTick: async () => undefined,
    runStart: async () => undefined,
    runClaudeSmoke: async () => undefined,
  });

  await dispatchMainCommand({
    args: ['sandbox', 'up'],
    runInit: async () => {
      calls.push('init-again');
    },
    runSandbox: async () => {
      calls.push('sandbox');
    },
    runTick: async () => undefined,
    runStart: async () => undefined,
    runClaudeSmoke: async () => undefined,
  });

  expect(calls).toEqual(['init', 'sandbox']);
});
```

```ts
it('publishes sandbox-aware resume guidance in wake comments', async () => {
  const comments: string[] = [];
  const source = createGitHubIssuesWorkSource({
    client: {
      listIssues: async () => [],
      listComments: async () => [],
      createComment: async (_owner, _repo, _issue, body) => {
        comments.push(body);
        return {};
      },
    },
    stateStore: createStateStore({ wakeRoot: await mkdtemp(join(tmpdir(), 'wake-gh-')) }),
    config: createDefaultWakeConfig('/wake-home'),
    now: () => new Date('2026-07-05T12:00:00.000Z'),
  });

  await source.deliverIntent({
    event: createEventEnvelope({
      eventId: 'evt-1',
      workItemKey: 'atolis-hq/wake#12',
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'ticket.reply',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 12,
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:00.000Z',
      trigger: 'context-only',
      payload: {
        body: 'Implemented',
        sessionId: 'session-12',
        workspacePath: '/wake/workspaces/atolis-hq__wake/12',
      },
    }),
  });

  expect(comments[0]).toContain('wake sandbox resume session-12 --cwd "/wake/workspaces/atolis-hq__wake/12"');
});
```

- [ ] **Step 2: Run the routing and comment tests to verify they fail**

Run: `npx vitest run test/cli/main.test.ts test/adapters/github-issues-work-source.test.ts`

Expected: FAIL because the main-command dispatcher does not route `init` / `sandbox`, and Wake comments still show host-only `cd ... ; claude --resume ...` guidance.

- [ ] **Step 3: Write the minimal CLI router and comment update**

```ts
export async function dispatchMainCommand(input: {
  args: string[];
  runInit: (args: string[]) => Promise<unknown>;
  runSandbox: (args: string[]) => Promise<unknown>;
  runTick: (args: string[]) => Promise<unknown>;
  runStart: (args: string[]) => Promise<unknown>;
  runClaudeSmoke: (args: string[]) => Promise<unknown>;
}) {
  const command = input.args[0] ?? 'tick';

  if (command === 'init') {
    await input.runInit(input.args.slice(1));
    return;
  }
  if (command === 'sandbox') {
    await input.runSandbox(input.args.slice(1));
    return;
  }
  if (command === 'tick') {
    await input.runTick(input.args.slice(1));
    return;
  }
  if (command === 'start') {
    await input.runStart(input.args.slice(1));
    return;
  }
  if (command === 'smoke' && input.args[1] === 'claude') {
    await input.runClaudeSmoke(input.args.slice(2));
    return;
  }

  throw new Error(`Unknown command: ${input.args.join(' ')}`);
}
```

```ts
const resumeCommand =
  workspacePath === undefined
    ? `wake sandbox resume ${sessionId}`
    : `wake sandbox resume ${sessionId} --cwd "${workspacePath}"`;
```

Retain `tick`, `start`, and `smoke claude` behavior exactly as-is; the only change in this task is top-level routing plus the user-facing resume command string.

- [ ] **Step 4: Run the routing and comment tests to verify they pass**

Run: `npx vitest run test/cli/main.test.ts test/adapters/github-issues-work-source.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/adapters/github/github-issues-work-source.ts test/cli/main.test.ts test/adapters/github-issues-work-source.test.ts
git commit -m "feat: route sandbox cli and publish sandbox resume guidance"
```

### Task 6: Document the sandbox workflow and run automated plus manual verification

**Files:**
- Modify: `README.md`
- Modify: `docs/implementation.md`

- [ ] **Step 1: Write the failing documentation and verification checks**

```md
## Sandbox workflow
```

Plan for this task's initial failure to be visible via grep: the repo should not yet document `wake init`, `wake sandbox build`, `wake sandbox up`, or the first-run setup flow.

- [ ] **Step 2: Verify the current documentation gap**

Run: `rg -n "wake init|wake sandbox build|wake sandbox up|claude setup-token" README.md docs/implementation.md`

Expected: no matches for the new sandbox workflow documentation.

- [ ] **Step 3: Write the minimal docs and verification wiring**

```json
"scripts": {
  "verify": "npm run build && npm test"
}
```

Verify that `package.json` keeps `"verify": "npm run build && npm test"`, then add a short `README.md` section with this exact command sequence:

```bash
npm install
npm run build
npx tsx src/main.ts init ~/wake-home
npx tsx src/main.ts sandbox build --wake-root ~/wake-home
npx tsx src/main.ts sandbox up --wake-root ~/wake-home
npx tsx src/main.ts sandbox setup --wake-root ~/wake-home
```

Update `docs/implementation.md` to explain:

```md
- Wake now supports one durable Docker sandbox per host.
- `config.json` and `prompts/*.md` live in the scaffolded Wake home and are bind-mounted into the container.
- The container user's home is persisted through `<wakeRoot>/container-home`.
- `wake sandbox resume` is the supported path for resuming Claude sessions that live inside the container-mounted workspace tree.
```

- [ ] **Step 4: Run automated verification, then perform manual Docker smoke checks**

Run: `npm run verify`

Expected: PASS

Then run these manual smoke checks on a Docker-capable machine:

Run: `npx tsx src/main.ts init .tmp/wake-home`

Expected: `.tmp/wake-home/config.json`, `.tmp/wake-home/prompts/`, `.tmp/wake-home/docker/`, and runtime directories are created.

Run: `npx tsx src/main.ts sandbox build --wake-root .tmp/wake-home`

Expected: Docker image `wake-sandbox` builds successfully from repo-root context.

Run: `npx tsx src/main.ts sandbox up --wake-root .tmp/wake-home`

Expected: A running `wake-sandbox` container exists with `/wake` and `/home/wake` bind mounts.

Run: `npx tsx src/main.ts sandbox exec --wake-root .tmp/wake-home -- pwd`

Expected: prints `/home/wake` or the invoked shell location from inside the running container.

Run: `npx tsx src/main.ts sandbox setup --wake-root .tmp/wake-home`

Expected: interactive `gh auth login`, `gh auth setup-git`, SSH key creation or reuse, and `claude setup-token` all run inside the container.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/implementation.md
git commit -m "docs: add wake sandbox workflow"
```
