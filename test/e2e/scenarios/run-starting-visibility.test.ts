import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, vi } from 'vitest';
import { ActivityRegistry, agentActivityDefinition } from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { EventActorKind, correlationId } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

defineScenario(
  {
    id: 'E2E-EXEC-STARTING-001',
    title: 'a workspace preparation Run is visible before its runner starts',
    given: [
      'a file-backed composition root with a real branch workspace and a prepare hook blocked by a release marker',
      'a composed fake runner whose completion is held by the scenario',
    ],
    when: [
      'a runnable agent activation is dispatched and workspace preparation enters its marker boundary',
    ],
    then: [
      'the composed execution and board APIs expose one active starting Run with no execution start time',
      'releasing preparation moves that same Run to running before the held runner completes it',
      'the terminal Run retains its identity and the board removes its active entry',
    ],
  },
  async () => {
    const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-run-starting-e2e-'));
    roots.push(wakeRoot);
    const enteredMarker = join(wakeRoot, 'prepare-entered');
    const releaseMarker = join(wakeRoot, 'prepare-release');
    const repository = await createRepository(wakeRoot);
    await writePrepareHook(wakeRoot, enteredMarker, releaseMarker);
    const restoreGitRedirect = redirectGitHubCloneTo(repository);
    const runner = deferred<{
      readonly transport: 'succeeded';
      readonly output: string;
      readonly runner: string;
    }>();
    let advance: Promise<unknown> | undefined;
    try {
      const activities = new ActivityRegistry();
      activities.register(agentActivityDefinition);
      const root = await createCompositionRoot(wakeRoot, {
        activities,
        config: startingVisibilityConfig(wakeRoot, enteredMarker, releaseMarker),
        decorateRunner() {
          return {
            async start() {
              return {
                result: runner.promise,
                async cancel() {
                  runner.resolve(fakeRunnerResult());
                },
              };
            },
          };
        },
      });
      const applications = await createSurfaceApplications(root);
      const context = commandContext('starting-visibility');
      const work = await root.work.create(
        { workItemId: workId('starting-visibility'), objective: 'Expose preparation progress' },
        context,
      );
      const resource = await root.resources.discover(
        {
          resourceId: resId('start'),
          kind: BuiltInResourceKind.Repository,
          externalKey: { adapter: 'github', key: 'wake-test/starting-visibility#1' },
          capabilities: [],
        },
        context,
      );
      await root.resources.correlate(resource.resourceId, work.workItemId, 'primary', context);
      await root.orchestration.start(
        {
          workflowInstanceId: workflowInstanceId('workflow-starting-visibility'),
          workItemId: work.workItemId,
          workflowName: workflowName('starting-visibility'),
          orchestrationGroupId: orchestrationGroupId('group-starting-visibility'),
        },
        context,
      );

      advance = root.advanceOnce({ maxProgress: 1 });
      await waitForFile(enteredMarker);
      await root.projectionSubscriptions.catchUpOnce();

      const startingRuns = await applications.api.execution.list({ limit: 10 });
      expect(startingRuns.items).toHaveLength(1);
      const runId = startingRuns.items[0]!.runId;
      expect(startingRuns.items[0]).toMatchObject({
        status: 'starting',
        active: true,
        startedAt: expect.any(String),
      });
      expect(startingRuns.items[0]!.executionStartedAt).toBeUndefined();
      expect(startingRuns.items[0]!.finishedAt).toBeUndefined();
      const startingBoard = await applications.api.board!.list({ limit: 10 });
      expect(startingBoard.items).toHaveLength(1);
      expect(startingBoard.items[0]).toMatchObject({
        workItemId: work.workItemId,
        condition: 'active',
        activeRuns: { [runId]: { phase: 'starting' } },
      });

      await writeFile(releaseMarker, 'release\n');
      await expect(advance).resolves.toMatchObject({ kind: 'progressed' });
      await root.projectionSubscriptions.catchUpOnce();

      const runningRuns = await applications.api.execution.list({ limit: 10 });
      expect(runningRuns.items).toHaveLength(1);
      expect(runningRuns.items[0]).toMatchObject({
        runId,
        status: 'started',
        active: true,
        executionStartedAt: expect.any(String),
      });
      const runningBoard = await applications.api.board!.list({ limit: 10 });
      expect(runningBoard.items[0]).toMatchObject({
        condition: 'active',
        activeRuns: { [runId]: { phase: 'running' } },
      });

      runner.resolve(fakeRunnerResult());
      await vi.waitFor(
        async () => {
          expect(
            (await root.execution.list()).find((candidate) => candidate.runId === runId),
          ).toMatchObject({
            status: 'succeeded',
            finishedAt: expect.any(String),
          });
        },
        { timeout: 10_000, interval: 20 },
      );
      await root.advanceOnce({ maxProgress: 1 });
      await root.projectionSubscriptions.catchUpOnce();

      const terminalRuns = await applications.api.execution.list({ limit: 10 });
      expect(terminalRuns.items).toHaveLength(1);
      expect(terminalRuns.items[0]).toMatchObject({
        runId,
        status: 'succeeded',
        active: false,
        finishedAt: expect.any(String),
      });
      const terminalBoard = await applications.api.board!.list({ limit: 10 });
      expect(terminalBoard.items[0]).toMatchObject({ condition: 'needs-input' });
      expect(terminalBoard.items[0]!.activeRuns).toEqual({});
    } finally {
      await writeFile(releaseMarker, 'release\n');
      runner.resolve(fakeRunnerResult());
      await advance?.catch(() => undefined);
      restoreGitRedirect();
    }
  },
  30_000,
);

function startingVisibilityConfig(wakeRoot: string, enteredMarker: string, releaseMarker: string) {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    activities: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
      workspaceHooks: {
        prepare: {
          command: `${quote(process.execPath)} ${quote(join(wakeRoot, 'prepare-workspace.cjs'))} ${quote(enteredMarker)} ${quote(releaseMarker)}`,
          timeoutMs: 20_000,
        },
      },
    },
    orchestration: {
      default: 'starting-visibility',
      workflows: {
        'starting-visibility': {
          stages: {
            implement: {
              activity: agentActivityDefinition.name,
              with: { prompt: 'Finish the prepared workspace.' },
              execution: { workspace: 'branch' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {},
    integrations: {},
    surfaces: {},
  });
}

async function createRepository(wakeRoot: string): Promise<string> {
  const repository = join(wakeRoot, 'source-repository');
  await mkdir(repository, { recursive: true });
  await execFileAsync('git', ['init', repository]);
  await writeFile(join(repository, 'README.md'), 'starting visibility fixture\n');
  await execFileAsync('git', ['-C', repository, 'add', 'README.md']);
  await execFileAsync('git', [
    '-C',
    repository,
    '-c',
    'user.name=Wake E2E',
    '-c',
    'user.email=wake@example.test',
    'commit',
    '-m',
    'initial',
  ]);
  return repository;
}

async function writePrepareHook(
  wakeRoot: string,
  enteredMarker: string,
  releaseMarker: string,
): Promise<void> {
  await writeFile(
    join(wakeRoot, 'prepare-workspace.cjs'),
    [
      "const { access, writeFile } = require('node:fs/promises');",
      'const [enteredMarker, releaseMarker] = process.argv.slice(2);',
      'const delay = () => new Promise((resolve) => setTimeout(resolve, 20));',
      '(async () => {',
      "  await writeFile(enteredMarker, 'entered\\n');",
      '  for (;;) {',
      '    try {',
      '      await access(releaseMarker);',
      '      return;',
      '    } catch {',
      '      await delay();',
      '    }',
      '  }',
      '})().catch((error) => {',
      '  console.error(error);',
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'),
  );
}

function redirectGitHubCloneTo(repository: string): () => void {
  const configured = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10);
  const index = Number.isSafeInteger(configured) && configured >= 0 ? configured : 0;
  const keys = [
    'GIT_CONFIG_COUNT',
    `GIT_CONFIG_KEY_${index}`,
    `GIT_CONFIG_VALUE_${index}`,
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  process.env[`GIT_CONFIG_KEY_${index}`] =
    `url.file://${repository.replaceAll('\\', '/')}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${index}`] = 'https://github.com/wake-test/starting-visibility.git';
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function commandContext(id: string) {
  return {
    commandId: id,
    correlationId: correlationId(id),
    occurredAt: new Date().toISOString(),
    actor: { kind: EventActorKind.System, id: 'test' },
  };
}

function fakeRunnerResult() {
  return { transport: 'succeeded' as const, output: '{"status":"DONE"}', runner: 'fake' };
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(() => expect(access(path)).resolves.toBeUndefined(), {
    timeout: 10_000,
    interval: 20,
  });
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
