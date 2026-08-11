import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  ActivityOutcomeKind,
  ActivityRegistry,
  activityName,
} from '../../../src-next/activities/index.js';
import {
  createCompositionRoot,
  createSelfUpdateApplication,
  parseRootConfig,
} from '../../../src-next/bootstrap/index.js';
import { createSelfUpdateQuiescePort } from '../../../src-next/bootstrap/surface-cli-applications.js';
import { correlationId } from '../../../src-next/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src-next/orchestration/index.js';
import { workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-004',
    title: 'a retained failed maintenance lease blocks new activation dispatch',
    given: ['a composed source-mode root with a pending activation and a failed maintenance lease'],
    when: ['advance-once is invoked while the control plane is in maintenance'],
    then: ['the entire tick remains paused and the pending activation stays undispatched'],
  },
  async () => {
    const root = await createRoot(1);
    await start(root, 'pending');
    await root.maintenance.acquire('v2');
    await root.maintenance.fail(new Error('update failed'));

    expect(await root.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    expect(await root.execution.list()).toEqual([]);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-002',
    title: 'maintenance blocks dispatch and waits for a real active Run to become empty',
    given: ['a composed source-mode root with one pending and one slow active Run'],
    when: ['self-update enters its maintenance lease'],
    then: [
      'advance-once dispatches no new Run while quiescing',
      'the active Run receives a durable maintenance cancellation request',
      'checkout does not occur until the active execution view is empty',
    ],
  },
  async () => {
    const root = await createRoot();
    await start(root, 'slow');
    await start(root, 'pending');
    const active = await waitForActiveRun(root);

    await root.maintenance.acquire('v2');
    expect(await root.advanceOnce({ maxProgress: 1 })).toEqual({ kind: 'paused' });
    expect(await root.execution.list()).toHaveLength(1);

    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger(calls),
      source: source(calls, root),
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 1,
      cancellationTimeoutMs: 50,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    expect((await root.execution.list()).find((run) => run.runId === active.runId)).toMatchObject({
      cancellation: { reason: 'maintenance', requestedAt: expect.any(String) },
    });
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
  },
  10_000,
);

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-003',
    title: 'a completing Run drains during maintenance grace without cancellation',
    given: ['a composed source-mode root with a completing active Run'],
    when: ['self-update waits through its drain grace'],
    then: ['checkout follows an empty active execution view and no cancellation is recorded'],
  },
  async () => {
    const root = await createRoot(5);
    await start(root, 'completing');
    const active = await waitForActiveRun(root);
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger(calls),
      source: source(calls, root),
      quiesce: createSelfUpdateQuiescePort(root),
      drainTimeoutMs: 50,
      cancellationTimeoutMs: 50,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    const completed = (await root.execution.list()).find((run) => run.runId === active.runId);
    expect(completed).toMatchObject({ status: 'succeeded' });
    expect(completed?.cancellation).toBeUndefined();
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
  },
  10_000,
);

async function createRoot(completionDelayMs?: number) {
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-self-update-e2e-'));
  roots.push(wakeRoot);
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('slow'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      execute: (_, { signal }) =>
        new Promise((resolve, reject) => {
          if (completionDelayMs !== undefined)
            setTimeout(() => resolve({ kind: 'done' }), completionDelayMs);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    },
  });
  return createCompositionRoot(wakeRoot, {
    activities,
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      activities: {},
      integrations: {},
      surfaces: {},
      controlPlane: {},
      execution: { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      orchestration: {
        workflows: {
          default: {
            stages: {
              slow: {
                activity: 'slow',
                with: {},
                on: { done: { then: 'done' } },
                requiresApproval: false,
              },
            },
          },
        },
      },
      host: {
        development: { mode: 'source', repoRoot: wakeRoot },
        selfUpdate: { drainTimeoutMs: 1, cancellationTimeoutMs: 50 },
      },
    }),
  });
}

async function start(root: Awaited<ReturnType<typeof createRoot>>, id: string) {
  const context = {
    commandId: id,
    correlationId: correlationId(id),
    occurredAt: new Date().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
  const work = await root.work.create({ workItemId: workId(id), objective: id }, context);
  await root.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId(id),
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId(id),
    },
    context,
  );
}

async function waitForActiveRun(root: Awaited<ReturnType<typeof createRoot>>) {
  const advancing = root.advanceOnce({ maxProgress: 1 });
  for (let index = 0; index < 100; index += 1) {
    const active = (await root.execution.list()).find((run) => run.status === 'started');
    if (active !== undefined) return active;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await advancing;
  throw new Error('Expected a slow active Run');
}

function ledger(calls: string[]) {
  return {
    read: async () => 'v1',
    begin: async (tag: string) => {
      calls.push(`begin:${tag}`);
    },
    write: async (tag: string) => {
      calls.push(`ledger:${tag}`);
    },
    recover: async () => null,
    isBad: async () => false,
    recordBad: async () => {},
  };
}

function source(calls: string[], root: Awaited<ReturnType<typeof createRoot>>) {
  return {
    isClean: async () => true,
    latestTag: async () => 'v2',
    candidateTags: async () => ['v2'],
    checkout: async (tag: string) => {
      expect((await root.execution.list()).filter((run) => run.status === 'started')).toEqual([]);
      calls.push(`checkout:${tag}`);
    },
    healthy: async () => true,
  };
}
