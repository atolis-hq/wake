# Wake Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript Node control-plane skeleton for Wake with durable file-backed state, explicit schemas, fake GitHub and runner adapters, append-only event audits, and a resident/tick CLI.

**Architecture:** The implementation centers on a thin CLI over a modular control plane. Core orchestration depends on pure domain types and narrow interfaces, while filesystem IO, fake GitHub sync, and fake runner behavior live in adapters. Durable state is schema-validated and versioned so deterministic scripts can consume canonical fields while bundled agent-readable context can grow safely.

**Tech Stack:** Node.js, TypeScript, Vitest, Zod, tsx

---

### Task 1: Bootstrap the Node and TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.editorconfig`
- Modify: `README.md`
- Test: `package.json`

- [ ] **Step 1: Write the failing bootstrap verification**

```json
{
  "name": "wake",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

Write the initial `package.json` without dependencies first, then verify the project cannot yet build because the TypeScript toolchain is missing.

- [ ] **Step 2: Run bootstrap verification to watch it fail**

Run: `npm run build`

Expected: command fails because `tsc` is not installed or no TypeScript config exists yet.

- [ ] **Step 3: Write the minimal project scaffolding**

```json
{
  "name": "wake",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "tsx src/main.ts start",
    "tick": "tsx src/main.ts tick"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0",
    "zod": "^4.0.0"
  }
}
```

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
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
```

Update `README.md` with a short “Development” section showing `npm install`, `npm test`, and `npm run tick`.

- [ ] **Step 4: Run build and tests to verify the scaffold passes**

Run: `npm install`

Then run: `npm run build`

Expected: TypeScript build succeeds with no source files yet.

Then run: `npm test`

Expected: Vitest exits successfully with zero tests or a clean no-test run depending on the initial config behavior.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .editorconfig README.md package-lock.json
git commit -m "chore: bootstrap wake node skeleton"
```

### Task 2: Define the versioned domain schemas and durable record shapes

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/schema.ts`
- Create: `src/domain/stages.ts`
- Create: `test/domain/schema.test.ts`
- Test: `test/domain/schema.test.ts`

- [ ] **Step 1: Write the failing schema tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  parseIssueStateRecord,
  parseRunRecord,
  parseEventRecord,
  parseRunnerResultSentinel,
} from '../../src/domain/schema.js';

describe('issue state schema', () => {
  it('accepts canonical issue and comment fields plus extensible context', () => {
    const record = parseIssueStateRecord({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 12,
        title: 'Example',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [
        {
          id: 'c1',
          body: 'Need more detail <!-- wake -->',
          author: { login: 'shared-user' },
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
          isWakeAuthored: true,
        },
      ],
      wake: {
        stage: 'queue',
        attempts: 0,
        stageHistory: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {
        agentBrief: 'Extra information for future prompts',
      },
    });

    expect(record.context.agentBrief).toBe('Extra information for future prompts');
  });

  it('rejects missing canonical wake stage', () => {
    expect(() =>
      parseIssueStateRecord({
        schemaVersion: 1,
        issue: {},
        comments: [],
        wake: {},
      }),
    ).toThrow(/stage/i);
  });
});

describe('run and event schemas', () => {
  it('accepts running run records', () => {
    const run = parseRunRecord({
      schemaVersion: 1,
      runId: 'run-1',
      repo: 'atolis-hq/wake',
      issueNumber: 12,
      action: 'refine',
      status: 'running',
      startedAt: '2026-07-05T12:00:00.000Z',
    });

    expect(run.status).toBe('running');
  });

  it('accepts append-only event records', () => {
    const event = parseEventRecord({
      schemaVersion: 1,
      type: 'issue.synced',
      occurredAt: '2026-07-05T12:00:00.000Z',
      repo: 'atolis-hq/wake',
      issueNumber: 12,
      payload: { labels: ['wake:queue'] },
    });

    expect(event.type).toBe('issue.synced');
  });

  it('parses the last sentinel occurrence from runner result text', () => {
    expect(parseRunnerResultSentinel('notes DONE more notes FAILED')).toBe('FAILED');
  });
});
```

- [ ] **Step 2: Run schema tests to verify they fail**

Run: `npm test -- test/domain/schema.test.ts`

Expected: FAIL because the domain schema modules do not exist yet.

- [ ] **Step 3: Write the minimal schema and stage implementation**

```ts
export const stageValues = ['queue', 'refined', 'active', 'blocked', 'done', 'failed'] as const;
export type Stage = (typeof stageValues)[number];
```

```ts
import { z } from 'zod';

const isoTimestamp = z.string().datetime({ offset: true });
const stageSchema = z.enum(['queue', 'refined', 'active', 'blocked', 'done', 'failed']);

const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({
    login: z.string(),
  }),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  isWakeAuthored: z.boolean(),
});

export const issueStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  issue: z.object({
    repo: z.string(),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    state: z.enum(['open', 'closed']),
    url: z.string().url(),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  }),
  comments: z.array(commentSchema),
  wake: z.object({
    stage: stageSchema,
    attempts: z.number().int().nonnegative(),
    lastRunId: z.string().optional(),
    sessionId: z.string().optional(),
    workspacePath: z.string().optional(),
    blockReason: z.string().optional(),
    syncedAt: isoTimestamp,
    stageHistory: z.array(
      z.object({
        stage: stageSchema,
        changedAt: isoTimestamp,
        reason: z.string(),
      }),
    ),
  }),
  context: z.record(z.string(), z.unknown()).default({}),
});

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  action: z.enum(['refine', 'implement']),
  status: z.enum(['running', 'completed', 'blocked', 'failed']),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
  sessionId: z.string().optional(),
  sentinel: z.enum(['DONE', 'BLOCKED', 'FAILED']).optional(),
  summary: z.string().optional(),
});

export const eventRecordSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.string(),
  occurredAt: isoTimestamp,
  repo: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  runId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export function parseIssueStateRecord(input: unknown) {
  return issueStateRecordSchema.parse(input);
}

export function parseRunRecord(input: unknown) {
  return runRecordSchema.parse(input);
}

export function parseEventRecord(input: unknown) {
  return eventRecordSchema.parse(input);
}

export function parseRunnerResultSentinel(result: string): 'DONE' | 'BLOCKED' | 'FAILED' {
  const matches = result.match(/DONE|BLOCKED|FAILED/g);
  return matches?.at(-1) as 'DONE' | 'BLOCKED' | 'FAILED' | undefined ?? 'FAILED';
}
```

Add matching exported TypeScript types in `src/domain/types.ts`.

- [ ] **Step 4: Run schema tests to verify they pass**

Run: `npm test -- test/domain/schema.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/domain/schema.ts src/domain/stages.ts test/domain/schema.test.ts
git commit -m "feat: add durable wake domain schemas"
```

### Task 3: Build the filesystem pathing, state store, and event audit layer

**Files:**
- Create: `src/config/defaults.ts`
- Create: `src/config/load-config.ts`
- Create: `src/lib/paths.ts`
- Create: `src/lib/json-file.ts`
- Create: `src/lib/event-log.ts`
- Create: `src/adapters/fs/state-store.ts`
- Create: `test/adapters/state-store.test.ts`
- Test: `test/adapters/state-store.test.ts`

- [ ] **Step 1: Write the failing state store tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../src/adapters/fs/state-store.js';

describe('state store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-state-store-'));
  });

  it('writes and reads issue state records in the canonical layout', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState({
      schemaVersion: 1,
      issue: {
        repo: 'atolis-hq/wake',
        number: 7,
        title: 'Spec',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/7',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        attempts: 0,
        stageHistory: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {},
    });

    const saved = await store.readIssueState('atolis-hq/wake', 7);
    expect(saved.issue.number).toBe(7);
  });

  it('appends structured event audit records', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.appendEvent({
      schemaVersion: 1,
      type: 'issue.synced',
      occurredAt: '2026-07-05T12:00:00.000Z',
      repo: 'atolis-hq/wake',
      issueNumber: 7,
      payload: { labels: ['wake:queue'] },
    });

    const contents = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(contents).toContain('"type":"issue.synced"');
  });
});
```

- [ ] **Step 2: Run state store tests to verify they fail**

Run: `npm test -- test/adapters/state-store.test.ts`

Expected: FAIL because the filesystem state store does not exist yet.

- [ ] **Step 3: Write the minimal state store implementation**

```ts
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}
```

```ts
import { join } from 'node:path';

export function createWakePaths(wakeRoot: string) {
  return {
    wakeRoot,
    configFile: join(wakeRoot, 'config.json'),
    ledgerFile: join(wakeRoot, 'ledger.json'),
    issueStateFile: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'state', repo.replace('/', '__'), `${issueNumber}.json`),
    runFile: (runId: string) => join(wakeRoot, 'runs', `${runId}.json`),
    eventFile: (date: string) => join(wakeRoot, 'events', `${date}.jsonl`),
  };
}
```

```ts
import { parseEventRecord, parseIssueStateRecord, parseRunRecord } from '../../domain/schema.js';
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../lib/json-file.js';
import { createWakePaths } from '../../lib/paths.js';

export function createStateStore({ wakeRoot }: { wakeRoot: string }) {
  const paths = createWakePaths(wakeRoot);

  return {
    async writeIssueState(record: unknown) {
      const parsed = parseIssueStateRecord(record);
      await writeJsonFile(paths.issueStateFile(parsed.issue.repo, parsed.issue.number), parsed);
      return parsed;
    },
    async readIssueState(repo: string, issueNumber: number) {
      return parseIssueStateRecord(await readJsonFile(paths.issueStateFile(repo, issueNumber)));
    },
    async writeRunRecord(record: unknown) {
      const parsed = parseRunRecord(record);
      await writeJsonFile(paths.runFile(parsed.runId), parsed);
      return parsed;
    },
    async appendEvent(record: unknown) {
      const parsed = parseEventRecord(record);
      const date = parsed.occurredAt.slice(0, 10);
      await appendJsonLine(paths.eventFile(date), parsed);
      return parsed;
    },
  };
}
```

Add a `loadConfig` helper that reads `config.json` when present and otherwise returns defaults with a configurable `wakeRoot`.

- [ ] **Step 4: Run state store tests to verify they pass**

Run: `npm test -- test/adapters/state-store.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/defaults.ts src/config/load-config.ts src/lib/paths.ts src/lib/json-file.ts src/lib/event-log.ts src/adapters/fs/state-store.ts test/adapters/state-store.test.ts
git commit -m "feat: add wake filesystem state store"
```

### Task 4: Add fake GitHub sync, Wake comment detection, and the workspace and runner adapters

**Files:**
- Create: `src/core/contracts.ts`
- Create: `src/adapters/fake/fake-work-source.ts`
- Create: `src/adapters/fake/fake-runner.ts`
- Create: `src/adapters/fake/fake-workspace-manager.ts`
- Create: `test/adapters/fake-work-source.test.ts`
- Test: `test/adapters/fake-work-source.test.ts`

- [ ] **Step 1: Write the failing fake work source tests**

```ts
import { describe, expect, it } from 'vitest';
import { createFakeWorkSource } from '../../src/adapters/fake/fake-work-source.js';

describe('fake work source', () => {
  it('marks wake-authored comments using the wake marker', async () => {
    const source = createFakeWorkSource({
      issues: [
        {
          repo: 'atolis-hq/wake',
          number: 3,
          title: 'Blocked item',
          body: 'Needs detail',
          labels: ['wake:blocked'],
          comments: [
            { id: 'c1', body: 'Question <!-- wake -->', author: { login: 'shared-user' } },
            { id: 'c2', body: 'Here is the answer', author: { login: 'shared-user' } },
          ],
        },
      ],
    });

    const items = await source.syncIssues();
    expect(items[0]?.comments.at(-1)?.isWakeAuthored).toBe(false);
  });
});
```

- [ ] **Step 2: Run fake work source tests to verify they fail**

Run: `npm test -- test/adapters/fake-work-source.test.ts`

Expected: FAIL because the adapter and contracts do not exist yet.

- [ ] **Step 3: Write the minimal fake adapters**

```ts
export interface WorkSource {
  syncIssues(): Promise<IssueStateRecord[]>;
}

export interface AgentRunner {
  run(input: {
    action: 'refine' | 'implement';
    issue: IssueStateRecord;
  }): Promise<{
    result: string;
    session_id?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface WorkspaceManager {
  prepareWorkspace(input: { repo: string; issueNumber: number }): Promise<{ workspacePath: string }>;
  cleanupWorkspace(input: { workspacePath: string }): Promise<void>;
}
```

```ts
import { parseIssueStateRecord } from '../../domain/schema.js';

function isWakeAuthoredComment(body: string): boolean {
  return body.includes('<!-- wake -->');
}

export function createFakeWorkSource(input: {
  issues: Array<{
    repo: string;
    number: number;
    title: string;
    body: string;
    labels: string[];
    comments: Array<{ id: string; body: string; author: { login: string } }>;
  }>;
}) {
  return {
    async syncIssues() {
      return input.issues.map((issue) =>
        parseIssueStateRecord({
          schemaVersion: 1,
          issue: {
            repo: issue.repo,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            labels: issue.labels,
            assignees: [],
            state: 'open',
            url: `https://example.test/${issue.repo}/issues/${issue.number}`,
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
          comments: issue.comments.map((comment) => ({
            ...comment,
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
            isWakeAuthored: isWakeAuthoredComment(comment.body),
          })),
          wake: {
            stage: issue.labels.includes('wake:blocked') ? 'blocked' : 'queue',
            attempts: 0,
            stageHistory: [],
            syncedAt: '2026-07-05T12:00:00.000Z',
          },
          context: {},
        }),
      );
    },
  };
}
```

```ts
export function createFakeRunner() {
  return {
    async run() {
      return {
        result: 'Fake runner completed\nDONE',
        session_id: 'fake-session-1',
        metadata: { source: 'fake-runner' },
      };
    },
  };
}
```

```ts
import { mkdir, rm } from 'node:fs/promises';

export function createFakeWorkspaceManager(root: string) {
  return {
    async prepareWorkspace({ repo, issueNumber }: { repo: string; issueNumber: number }) {
      const workspacePath = `${root}/${repo.replace('/', '__')}/${issueNumber}`;
      await mkdir(workspacePath, { recursive: true });
      return { workspacePath };
    },
    async cleanupWorkspace({ workspacePath }: { workspacePath: string }) {
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 4: Run fake work source tests to verify they pass**

Run: `npm test -- test/adapters/fake-work-source.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts.ts src/adapters/fake/fake-work-source.ts src/adapters/fake/fake-runner.ts src/adapters/fake/fake-workspace-manager.ts test/adapters/fake-work-source.test.ts
git commit -m "feat: add fake wake adapters"
```

### Task 5: Implement the tick runner, lock handling, lifecycle decisions, and crash-safe run persistence

**Files:**
- Create: `src/lib/clock.ts`
- Create: `src/lib/lock.ts`
- Create: `src/core/policy-engine.ts`
- Create: `src/core/lifecycle-service.ts`
- Create: `src/core/tick-runner.ts`
- Create: `test/core/tick-runner.test.ts`
- Test: `test/core/tick-runner.test.ts`

- [ ] **Step 1: Write the failing tick runner tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createFakeRunner } from '../../src/adapters/fake/fake-runner.js';
import { createFakeWorkSource } from '../../src/adapters/fake/fake-work-source.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createTickRunner } from '../../src/core/tick-runner.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  it('writes a running run record before invoking the runner', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runFileSnapshot = '';

    const runner = {
      async run() {
        runFileSnapshot = await readFile(join(root, 'runs', 'run-1.json'), 'utf8');
        return { result: 'Runner output\nDONE', session_id: 'session-1' };
      },
    };

    const tickRunner = createTickRunner({
      now: () => new Date('2026-07-05T12:00:00.000Z'),
      stateStore: store,
      workSource: createFakeWorkSource({
        issues: [
          {
            repo: 'atolis-hq/wake',
            number: 9,
            title: 'Implement',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner,
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(runFileSnapshot).toContain('"status": "running"');
  });

  it('creates event audit records for sync and completion', async () => {
    const store = createStateStore({ wakeRoot: root });
    const tickRunner = createTickRunner({
      now: () => new Date('2026-07-05T12:00:00.000Z'),
      stateStore: store,
      workSource: createFakeWorkSource({
        issues: [
          {
            repo: 'atolis-hq/wake',
            number: 10,
            title: 'Refine',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner: createFakeRunner(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(events).toContain('"type":"issue.synced"');
    expect(events).toContain('"type":"run.completed"');
  });
});
```

- [ ] **Step 2: Run tick runner tests to verify they fail**

Run: `npm test -- test/core/tick-runner.test.ts`

Expected: FAIL because the tick runner and supporting services do not exist yet.

- [ ] **Step 3: Write the minimal orchestration implementation**

```ts
import { open, rm } from 'node:fs/promises';

export async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const handle = await open(path, 'wx');
  return async () => {
    await handle.close();
    await rm(path, { force: true });
  };
}
```

```ts
export function createPolicyEngine() {
  return {
    chooseAction(stage: 'queue' | 'refined') {
      return stage === 'queue' ? 'refine' : 'implement';
    },
  };
}
```

```ts
export function createLifecycleService() {
  return {
    nextStageFromSentinel(action: 'refine' | 'implement', sentinel: 'DONE' | 'BLOCKED' | 'FAILED') {
      if (sentinel === 'BLOCKED') return 'blocked';
      if (sentinel === 'FAILED') return 'failed';
      return action === 'refine' ? 'refined' : 'done';
    },
  };
}
```

```ts
import { parseRunnerResultSentinel } from '../domain/schema.js';

export function createTickRunner(deps: {
  now: () => Date;
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
  workSource: import('./contracts.js').WorkSource;
  runner: import('./contracts.js').AgentRunner;
  workspaceManager: import('./contracts.js').WorkspaceManager;
}) {
  const policy = createPolicyEngine();
  const lifecycle = createLifecycleService();

  return {
    async runTick() {
      const synced = await deps.workSource.syncIssues();

      for (const issue of synced) {
        await deps.stateStore.writeIssueState(issue);
        await deps.stateStore.appendEvent({
          schemaVersion: 1,
          type: 'issue.synced',
          occurredAt: deps.now().toISOString(),
          repo: issue.issue.repo,
          issueNumber: issue.issue.number,
          payload: { stage: issue.wake.stage },
        });
      }

      const candidate = synced.find((issue) => issue.wake.stage === 'queue' || issue.wake.stage === 'refined');
      if (!candidate) {
        return { status: 'idle' as const };
      }

      const action = policy.chooseAction(candidate.wake.stage);
      const runId = 'run-1';
      const runRecord = {
        schemaVersion: 1,
        runId,
        repo: candidate.issue.repo,
        issueNumber: candidate.issue.number,
        action,
        status: 'running' as const,
        startedAt: deps.now().toISOString(),
      };

      await deps.stateStore.writeRunRecord(runRecord);

      const { workspacePath } = await deps.workspaceManager.prepareWorkspace({
        repo: candidate.issue.repo,
        issueNumber: candidate.issue.number,
      });

      const runnerResult = await deps.runner.run({ action, issue: candidate });
      const sentinel = parseRunnerResultSentinel(runnerResult.result);
      const nextStage = lifecycle.nextStageFromSentinel(action, sentinel);

      await deps.stateStore.writeRunRecord({
        ...runRecord,
        status: sentinel === 'DONE' ? 'completed' : sentinel === 'BLOCKED' ? 'blocked' : 'failed',
        finishedAt: deps.now().toISOString(),
        sessionId: runnerResult.session_id,
        sentinel,
        summary: runnerResult.result,
      });

      await deps.stateStore.writeIssueState({
        ...candidate,
        wake: {
          ...candidate.wake,
          stage: nextStage,
          lastRunId: runId,
          sessionId: runnerResult.session_id,
          workspacePath,
          syncedAt: deps.now().toISOString(),
          stageHistory: [
            ...candidate.wake.stageHistory,
            {
              stage: nextStage,
              changedAt: deps.now().toISOString(),
              reason: `runner:${sentinel.toLowerCase()}`,
            },
          ],
        },
      });

      await deps.stateStore.appendEvent({
        schemaVersion: 1,
        type: 'run.completed',
        occurredAt: deps.now().toISOString(),
        repo: candidate.issue.repo,
        issueNumber: candidate.issue.number,
        runId,
        payload: { action, sentinel, nextStage },
      });

      return { status: 'processed' as const, runId, sentinel, nextStage };
    },
  };
}
```

- [ ] **Step 4: Run tick runner tests to verify they pass**

Run: `npm test -- test/core/tick-runner.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/clock.ts src/lib/lock.ts src/core/policy-engine.ts src/core/lifecycle-service.ts src/core/tick-runner.ts test/core/tick-runner.test.ts
git commit -m "feat: add wake tick orchestration"
```

### Task 6: Add the CLI entrypoints, resident loop, and pause gate behavior

**Files:**
- Create: `src/core/control-plane.ts`
- Create: `src/main.ts`
- Create: `test/cli/control-plane.test.ts`
- Test: `test/cli/control-plane.test.ts`

- [ ] **Step 1: Write the failing CLI and resident loop tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createControlPlane } from '../../src/core/control-plane.js';

describe('control plane', () => {
  it('skips execution when the pause gate is active', async () => {
    const tickRunner = {
      runTick: vi.fn(),
    };

    const controlPlane = createControlPlane({
      tickRunner,
      intervalMs: 10,
      isPaused: () => true,
      logger: { info() {}, error() {} },
      sleep: async () => {},
    });

    await controlPlane.runOnce();

    expect(tickRunner.runTick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run: `npm test -- test/cli/control-plane.test.ts`

Expected: FAIL because the control plane and CLI entrypoint do not exist yet.

- [ ] **Step 3: Write the minimal resident control plane and CLI**

```ts
export function createControlPlane(deps: {
  tickRunner: { runTick: () => Promise<unknown> };
  intervalMs: number;
  isPaused: () => boolean;
  logger: { info: (message: string) => void; error: (message: string) => void };
  sleep: (ms: number) => Promise<void>;
}) {
  let running = true;

  return {
    stop() {
      running = false;
    },
    async runOnce() {
      if (deps.isPaused()) {
        deps.logger.info('Wake is paused');
        return { status: 'paused' as const };
      }
      return deps.tickRunner.runTick();
    },
    async start() {
      while (running) {
        try {
          await this.runOnce();
        } catch (error) {
          deps.logger.error(error instanceof Error ? error.message : String(error));
        }
        await deps.sleep(deps.intervalMs);
      }
    },
  };
}
```

```ts
import { createControlPlane } from './core/control-plane.js';

const command = process.argv[2] ?? 'tick';

if (command === 'tick') {
  console.log('Wake tick command not yet wired');
} else if (command === 'start') {
  console.log('Wake start command not yet wired');
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
```

Wire `src/main.ts` to construct the real fake-backed `ControlPlane` and `TickRunner`, and have `tick` run one tick while `start` enters the loop with signal handling.

- [ ] **Step 4: Run CLI tests to verify they pass**

Run: `npm test -- test/cli/control-plane.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/control-plane.ts src/main.ts test/cli/control-plane.test.ts
git commit -m "feat: add wake cli control plane"
```

### Task 7: Document the core architecture and keep the repo consistent

**Files:**
- Create: `docs/architecture.md`
- Modify: `README.md`
- Test: `README.md`

- [ ] **Step 1: Write the failing documentation check**

```md
# Core Architecture
```

Plan for the test to be manual: the repository should currently lack a document that explains module boundaries, schema-first durable state, canonical versus extensible fields, and how fake adapters map to future real integrations.

- [ ] **Step 2: Verify the documentation gap**

Run: `rg -n "Core Architecture|schema-first durable state|event audits" docs README.md`

Expected: no match for the architecture guidance that the design requires.

- [ ] **Step 3: Write the minimal architecture documentation**

```md
# Wake Architecture

## Principles

- Wake is a control plane, not a long-lived worker session.
- Durable state files are schema-validated state-of-record.
- Canonical deterministic fields stay separate from extensible agent-readable context.
- Structured event audits drive automation and diagnostics.
- Fake adapters are permanent test harnesses and future real-adapter seams.

## Module boundaries

- `src/domain`: pure types and schemas
- `src/core`: orchestration and policy
- `src/adapters`: IO and fake integrations
- `src/lib`: small reusable utilities
```

Update `README.md` to link to `docs/architecture.md` and document the `tick` and `start` commands.

- [ ] **Step 4: Verify the documentation now exists**

Run: `rg -n "Wake Architecture|Structured event audits|schema-validated state-of-record" docs README.md`

Expected: matches in `docs/architecture.md` and `README.md`

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md README.md
git commit -m "docs: add wake architecture guide"
```

### Task 8: Run the full verification suite and close the skeleton

**Files:**
- Modify: `package.json`
- Test: `test/domain/schema.test.ts`
- Test: `test/adapters/state-store.test.ts`
- Test: `test/adapters/fake-work-source.test.ts`
- Test: `test/core/tick-runner.test.ts`
- Test: `test/cli/control-plane.test.ts`

- [ ] **Step 1: Write the failing full-suite verification command**

```json
{
  "scripts": {
    "verify": "npm run build && npm test"
  }
}
```

Add the `verify` script only after the suite is assembled, then confirm it fails if any integration gap remains.

- [ ] **Step 2: Run full verification to watch it fail if the skeleton is incomplete**

Run: `npm run verify`

Expected: any remaining type, wiring, or test failures are exposed before completion.

- [ ] **Step 3: Write the minimal final wiring or fixes**

```ts
// Example of acceptable final fixes:
// - export missing types from schema modules
// - correct CLI construction of the fake-backed control plane
// - fix test fixtures to match schemaVersion 1 records exactly
```

Only make the smallest fixes necessary to get the build and all tests green.

- [ ] **Step 4: Run full verification to confirm the skeleton passes**

Run: `npm run verify`

Expected: PASS with a clean TypeScript build and all Vitest suites green.

- [ ] **Step 5: Commit**

```bash
git add package.json src test
git commit -m "feat: complete wake control plane skeleton"
```
