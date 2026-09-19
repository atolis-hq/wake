import { EventActorKind, correlationId } from '@atolis-hq/eventing';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect } from 'vitest';
import { ActivityRegistry, agentActivityDefinition } from '../../../src/activities/index.js';
import { createCompositionRoot, parseRootConfig } from '../../../src/bootstrap/index.js';
import { runId } from '../../../src/execution/contracts/identifiers.js';
import { GitWorkspaceProvider } from '../../../src/execution/infrastructure/workspace/git-workspace.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { BuiltInResourceKind, resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

defineScenario(
  {
    id: 'E2E-EXEC-WORKSPACE-004',
    title: 'a repeated read-only turn reuses its prepared checkout',
    given: ['an open WorkItem with a local Git repository and a read-only workspace hook'],
    when: ['two turns acquire and release that WorkItem workspace'],
    then: [
      'the second turn uses the same checkout without another clone and runs preparation again',
    ],
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-read-only-e2e-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await execFileAsync('git', ['init', repository]);
    await writeFile(join(repository, 'README.md'), 'fixture\n');
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
      'fixture',
    ]);
    let clones = 0;
    const provider = new GitWorkspaceProvider(
      join(root, 'workspaces'),
      { cloneLocator: async () => repository },
      async (arguments_, signal) => {
        if (arguments_[0] === 'clone') clones += 1;
        await execFileAsync('git', arguments_, { signal });
      },
      undefined,
      {
        command: `${JSON.stringify(process.execPath)} -e "require('node:fs').appendFileSync('.prepared', 'x')"`,
        timeoutMs: 10_000,
      },
    );
    const request = {
      signal: new AbortController().signal,
      mode: 'read-only' as const,
      workItemId: workId('read-only-e2e'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'wake-test/read-only#1' },
        capabilities: [],
      },
    };
    const first = await provider.acquire({ ...request, runId: runId('run-read-only-e2e-first') });
    await first.release();
    const second = await provider.acquire({ ...request, runId: runId('run-read-only-e2e-second') });
    expect(second.path).toBe(first.path);
    expect(clones).toBe(1);
    await expect(readFile(join(second.path, '.prepared'), 'utf8')).resolves.toBe('xx');
    await second.release();
  },
  30_000,
);

defineScenario(
  {
    id: 'E2E-EXEC-WORKSPACE-005',
    title: 'composed read-only turns retain their checkout',
    given: ['a composed Wake root and an open repository-backed WorkItem'],
    when: ['two sequential workflow stages dispatch read-only turns'],
    then: ['both Runs record one workspace path and preparation is retained'],
  },
  async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'wake-composed-read-only-'));
    roots.push(rootPath);
    const source = join(rootPath, 'source');
    await execFileAsync('git', ['init', source]);
    await writeFile(join(source, 'README.md'), 'fixture\n');
    await execFileAsync('git', ['-C', source, 'add', 'README.md']);
    await execFileAsync('git', [
      '-C',
      source,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@test',
      'commit',
      '-m',
      'fixture',
    ]);
    const restore = redirect(source);
    try {
      const activities = new ActivityRegistry();
      activities.register(agentActivityDefinition);
      const root = await createCompositionRoot(rootPath, {
        activities,
        config: parseRootConfig({
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
                command: `${JSON.stringify(process.execPath)} -e "require('node:fs').appendFileSync('.prepared', 'x')"`,
                timeoutMs: 10000,
              },
            },
          },
          orchestration: {
            default: 'readonly',
            workflows: {
              readonly: {
                stages: {
                  first: {
                    activity: agentActivityDefinition.name,
                    with: { prompt: 'go' },
                    execution: { workspace: 'read-only' },
                    on: { done: { then: 'second' } },
                    requiresApproval: false,
                  },
                  second: {
                    activity: agentActivityDefinition.name,
                    with: { prompt: 'go again' },
                    execution: { workspace: 'read-only' },
                    on: { done: { then: 'done' } },
                    requiresApproval: false,
                  },
                },
              },
            },
          },
          controlPlane: {},
          integrations: {},
          surfaces: {},
        }),
        decorateRunner: () => ({
          async start() {
            return {
              result: Promise.resolve({
                transport: 'succeeded' as const,
                output: '{"status":"DONE"}',
                runner: 'fake',
              }),
              async cancel() {},
            };
          },
        }),
      });
      const context = {
        commandId: 'composed-readonly',
        correlationId: correlationId('composed-readonly'),
        occurredAt: new Date().toISOString(),
        actor: { kind: EventActorKind.System, id: 'test' },
      };
      const work = await root.work.create(
        { workItemId: workId('composed-readonly'), objective: 'reuse' },
        context,
      );
      const resource = await root.resources.discover(
        {
          resourceId: resId('composed-readonly'),
          kind: BuiltInResourceKind.Repository,
          externalKey: { adapter: 'github', key: 'wake-test/composed#1' },
          capabilities: [],
        },
        context,
      );
      await root.resources.correlate(resource.resourceId, work.workItemId, 'primary', context);
      await root.orchestration.start(
        {
          workflowInstanceId: workflowInstanceId('readonly-sequential'),
          workItemId: work.workItemId,
          workflowName: workflowName('readonly'),
          orchestrationGroupId: orchestrationGroupId('readonly-sequential'),
        },
        context,
      );
      for (
        let index = 0;
        index < 100 &&
        ((await root.execution.list()).length < 2 ||
          !(await root.execution.list()).every((run) => run.status === 'succeeded'));
        index += 1
      ) {
        await root.advanceOnce({ maxProgress: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const runs = await root.execution.list();
      expect(runs).toHaveLength(2);
      expect(runs[0]!.workspace?.path).toBe(runs[1]!.workspace?.path);
      await expect(readFile(join(runs[0]!.workspace!.path, '.prepared'), 'utf8')).resolves.toBe(
        'xx',
      );
    } finally {
      restore();
    }
  },
  30_000,
);

function redirect(source: string): () => void {
  const index = Number(process.env.GIT_CONFIG_COUNT ?? '0');
  const keys = [
    'GIT_CONFIG_COUNT',
    `GIT_CONFIG_KEY_${index}`,
    `GIT_CONFIG_VALUE_${index}`,
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  process.env[`GIT_CONFIG_KEY_${index}`] = `url.file://${source}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${index}`] = 'https://github.com/wake-test/composed.git';
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
