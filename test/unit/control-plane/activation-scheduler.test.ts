import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  activityName,
  ActivityRegistry,
} from '../../../src/activities/index.js';
import { createFileActivationSchedulerSerialiser } from '../../../src/bootstrap/index.js';
import {
  createActivationScheduler,
  type ActivationSchedulerSerialiser,
} from '../../../src/control-plane/index.js';
import {
  createExecutionService,
  ExecutionEventType,
  RunStatus,
} from '../../../src/execution/index.js';
import type {
  ActivityActivationView,
  WorkflowInstanceView,
} from '../../../src/orchestration/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';
import { resId } from '../../support/identities.js';

function candidate(id = 'one') {
  return {
    workflow: {
      workflowInstanceId: `workflow-${id}`,
      workItemId: `work-${id}`,
      orchestrationGroupId: `group-${id}`,
      acceptedOutcomes: [],
    } as unknown as WorkflowInstanceView,
    activation: { activationId: `activation-${id}` } as unknown as ActivityActivationView,
  };
}

describe('ActivationScheduler', () => {
  it('releases its serialiser after durable agent preparation while workspace acquisition is pending', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('agent-with-workspace'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Agent,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    const acquireEntered = deferred<void>();
    const releaseAcquire = deferred<void>();
    const execution = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            acquireEntered.resolve();
            await releaseAcquire.promise;
            return {
              workspaceId: 'workspace-one',
              path: '/workspace-one',
              mode: 'read-only',
              async release() {},
            };
          },
        },
      },
    );
    const pending = candidate();
    const repository = {
      resourceId: resId('repository-one'),
      kind: BuiltInResourceKind.Repository,
      externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
      capabilities: [],
    };
    const activation = {
      ...pending.activation,
      ordinal: 1,
      activity: activityName('agent-with-workspace'),
      input: { prompt: 'ship' },
      execution: { workspace: 'read-only' as const },
      status: 'pending' as const,
    } as ActivityActivationView;
    const scheduler = createActivationScheduler(
      {
        reconcileChildCompletions: async () => undefined,
        listPendingActivations: async () => [{ workflow: pending.workflow, activation }],
        listWaiting: async () => [],
        acceptOutcome: async () => pending.workflow,
        markActivationStarted: async () => pending.workflow,
      },
      execution,
      {
        correlationsForWork: async () => [{ resourceId: repository.resourceId }],
        get: async () => repository,
      } as never,
      clock,
      { ids: { next: () => 'command-agent-preparation' } as never },
    );

    const pass = scheduler.runOnce({ maxProgress: 1 });
    await acquireEntered.promise;
    const result = await Promise.race([
      pass.then((value) => ({ kind: 'resolved' as const, value })),
      new Promise<{ kind: 'pending' }>((resolve) => {
        setImmediate(() => resolve({ kind: 'pending' }));
      }),
    ]);
    const preparing = (await execution.list(activation.activationId))[0];
    const eventTypes = (await journal.readAll(0)).map((event) => event.event.eventType);
    releaseAcquire.resolve();
    await expect(pass).resolves.toMatchObject({ kind: 'progressed' });

    expect(result).toMatchObject({
      kind: 'resolved',
      value: {
        kind: 'progressed',
        dispatched: [{ activationId: activation.activationId, runId: 'run-1' }],
      },
    });
    expect(preparing).toMatchObject({
      runId: 'run-1',
      status: RunStatus.Starting,
    });
    expect(eventTypes).toContain(ExecutionEventType.RunPreparationStarted);
    await expect
      .poll(async () => (await execution.list(activation.activationId))[0]?.status)
      .toBe(RunStatus.Succeeded);
  });

  it('releases the file-backed serialiser while detached workspace acquisition remains pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-detached-scheduler-'));
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('file-serialised-agent'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Agent,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    const acquireEntered = deferred<void>();
    const releaseAcquire = deferred<void>();
    const execution = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            acquireEntered.resolve();
            await releaseAcquire.promise;
            return {
              workspaceId: 'workspace-file-lock',
              path: '/workspace-file-lock',
              mode: 'read-only',
              async release() {},
            };
          },
        },
      },
    );
    const pending = candidate('file-lock');
    const repository = {
      resourceId: resId('repository-file-lock'),
      kind: BuiltInResourceKind.Repository,
      externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
      capabilities: [],
    };
    const activation = {
      ...pending.activation,
      ordinal: 1,
      activity: activityName('file-serialised-agent'),
      input: { prompt: 'ship' },
      execution: { workspace: 'read-only' as const },
      status: 'pending' as const,
    } as ActivityActivationView;
    const resources = {
      correlationsForWork: async () => [{ resourceId: repository.resourceId }],
      get: async () => repository,
    } as never;
    const orchestration = {
      reconcileChildCompletions: async () => undefined,
      listPendingActivations: async () => [{ workflow: pending.workflow, activation }],
      listWaiting: async () => [],
      acceptOutcome: async () => pending.workflow,
      markActivationStarted: async () => pending.workflow,
    };
    const first = createActivationScheduler(orchestration, execution, resources, clock, {
      ids: { next: () => 'command-file-first' } as never,
      schedulerSerialiser: createFileActivationSchedulerSerialiser(root),
    });
    let secondHasEntered = false;
    const second = createActivationScheduler(orchestration, execution, resources, clock, {
      ids: { next: () => 'command-file-second' } as never,
      schedulerSerialiser: createFileActivationSchedulerSerialiser(root),
      isDispatchPaused: async () => {
        secondHasEntered = true;
        return false;
      },
    });

    try {
      await expect(first.runOnce({ maxProgress: 1 })).resolves.toMatchObject({
        kind: 'progressed',
      });
      await acquireEntered.promise;
      const secondPass = second.runOnce({ maxProgress: 1 });
      await vi.waitFor(() => expect(secondHasEntered).toBe(true));
      await expect(secondPass).resolves.toEqual({ kind: 'no-work' });
      releaseAcquire.resolve();
      await expect
        .poll(async () => (await execution.list(activation.activationId))[0]?.status)
        .toBe(RunStatus.Succeeded);
    } finally {
      releaseAcquire.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs the full scheduler sequence in order before dispatching the selected activation', async () => {
    const trace: string[] = [];
    const pending = candidate();
    const scheduler = createActivationScheduler(
      {
        reconcileChildCompletions: async () => {
          trace.push('child-reconciliation');
        },
        listPendingActivations: async () => {
          trace.push('pending');
          return [pending];
        },
        listWaiting: async () => [],
        acceptOutcome: async () => {
          throw new Error('No terminal outcome should be accepted');
        },
        markActivationStarted: async () => {
          trace.push('activation-claim');
          return pending.workflow;
        },
      },
      {
        recoverActive: async () => {
          trace.push('active-recovery');
          return [];
        },
        attempt: async () => {
          trace.push('workspace-acquisition');
          trace.push('run-started');
          return { runId: 'run-one', status: 'started' } as never;
        },
        list: async (activationId) => {
          if (activationId !== undefined) {
            trace.push(
              trace.includes('capacity-read')
                ? 'candidate-active-run-check'
                : 'terminal-reconciliation',
            );
            return [];
          }
          if (trace.includes('workspace-recovery')) {
            trace.push('capacity-read');
            return [];
          }
          trace.push('workspace-run-list');
          return [];
        },
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-29T00:00:00.000Z') },
      {
        ids: { next: () => 'command-one' } as never,
        isDispatchPaused: async () => {
          trace.push(
            `pause-gate:${trace.filter((entry) => entry.startsWith('pause-gate')).length + 1}`,
          );
          return false;
        },
        work: {
          get: async () => ({ state: 'closed' as never }),
        },
        workspaceRecovery: {
          recover: async (_runs, hooks) => {
            trace.push('workspace-recovery');
            await hooks?.onWorkspaceReclaimed?.(pending.workflow.workItemId);
            return { reclaimed: 0, failures: [] };
          },
        },
        transcriptRetention: {
          markClosedWorkItem: async () => {
            trace.push('transcript-cleanup');
            return true;
          },
          sweep: async () => {
            trace.push('transcript-sweep');
          },
        },
        maxDispatches: 1,
      },
    );

    await expect(scheduler.runOnce({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-one', runId: 'run-one' }],
    });
    expect(trace).toEqual([
      'pause-gate:1',
      'workspace-run-list',
      'workspace-recovery',
      'pause-gate:2',
      'transcript-cleanup',
      'pause-gate:3',
      'active-recovery',
      'pause-gate:4',
      'pause-gate:5',
      'transcript-sweep',
      'pause-gate:6',
      'child-reconciliation',
      'pause-gate:7',
      'pending',
      'terminal-reconciliation',
      'capacity-read',
      'candidate-active-run-check',
      'pause-gate:8',
      'activation-claim',
      'workspace-acquisition',
      'run-started',
    ]);
  });

  it('does not start any scheduler phase after the initial pause gate rejects the pass', async () => {
    const trace: string[] = [];
    const scheduler = createActivationScheduler(
      {
        reconcileChildCompletions: async () => {
          trace.push('child-reconciliation');
        },
        listPendingActivations: async () => {
          trace.push('pending');
          return [];
        },
        listWaiting: async () => [],
        acceptOutcome: async () => {
          throw new Error('No terminal outcome should be accepted');
        },
        markActivationStarted: async () => {
          throw new Error('No activation should start');
        },
      },
      {
        recoverActive: async () => {
          trace.push('active-recovery');
          return [];
        },
        attempt: async () => {
          throw new Error('No execution attempt should begin');
        },
        list: async () => {
          trace.push('run-list');
          return [];
        },
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-29T00:00:00.000Z') },
      {
        ids: { next: () => 'command-paused' } as never,
        isDispatchPaused: async () => {
          trace.push('pause-gate');
          return true;
        },
        workspaceRecovery: {
          recover: async () => {
            trace.push('workspace-recovery');
            return { reclaimed: 0, failures: [] };
          },
        },
      },
    );

    await expect(scheduler.runOnce({ maxProgress: 1 })).resolves.toEqual({ kind: 'paused' });
    expect(trace).toEqual(['pause-gate']);
  });

  it('uses the existing fair capacity-aware dispatch after recovery finds no terminal Run', async () => {
    const trace: string[] = [];
    const activeRuns = new Set<string>();
    const first = candidate('first');
    const second = candidate('second');
    const scheduler = createActivationScheduler(
      {
        reconcileChildCompletions: async () => {
          trace.push('child-reconciliation');
        },
        listPendingActivations: async () => [first, second],
        listWaiting: async () => [],
        acceptOutcome: async () => first.workflow,
        markActivationStarted: async (_workflowId, activationId) => {
          trace.push(`activation-claim:${activationId}`);
          return activationId === first.activation.activationId ? first.workflow : second.workflow;
        },
      },
      {
        attempt: async (activation) => {
          trace.push(`run-started:${activation.activationId}`);
          activeRuns.add(activation.activationId);
          return { runId: `run-${activation.activationId}`, status: 'started' } as never;
        },
        list: async () =>
          [...activeRuns].map((activationId) => ({ activationId, status: 'started' })) as never,
      },
      { correlationsForWork: async () => [] } as never,
      { now: () => new Date('2026-08-29T00:00:00.000Z') },
      { ids: { next: () => 'command-two' } as never, maxConcurrentRuns: 1, maxDispatches: 2 },
    );

    await expect(scheduler.runOnce({ maxProgress: 1 })).resolves.toEqual({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-first', runId: 'run-activation-first' }],
    });
    expect(trace).toEqual([
      'child-reconciliation',
      'activation-claim:activation-first',
      'run-started:activation-first',
    ]);
  });

  it('serialises capacity read, activation claim, and durable Run preparation', async () => {
    const activeRuns = new Set<string>();
    const trace: string[] = [];
    const serialiser = serialiseInOrder();
    const first = candidate('first');
    const second = candidate('second');
    const scheduler = (pending: ReturnType<typeof candidate>) =>
      createActivationScheduler(
        {
          reconcileChildCompletions: async () => undefined,
          listPendingActivations: async () => [pending],
          listWaiting: async () => [],
          acceptOutcome: async () => pending.workflow,
          markActivationStarted: async () => {
            trace.push(`activation-claim:${pending.activation.activationId}`);
            return pending.workflow;
          },
        },
        {
          attempt: async () => {
            activeRuns.add(pending.activation.activationId);
            trace.push(`run-prepared:${pending.activation.activationId}`);
            return { runId: `run-${pending.activation.activationId}`, status: 'starting' } as never;
          },
          list: async () =>
            [...activeRuns].map((activationId) => ({ activationId, status: 'started' })) as never,
        },
        { correlationsForWork: async () => [] } as never,
        { now: () => new Date('2026-08-29T00:00:00.000Z') },
        {
          ids: { next: () => 'command-three' } as never,
          maxConcurrentRuns: 1,
          schedulerSerialiser: serialiser,
        },
      );

    const [firstResult, secondResult] = await Promise.all([
      scheduler(first).runOnce({ maxProgress: 1 }),
      scheduler(second).runOnce({ maxProgress: 1 }),
    ]);

    expect(
      [firstResult, secondResult].filter((result) => result.kind === 'progressed'),
    ).toHaveLength(1);
    expect(activeRuns).toEqual(new Set(['activation-first']));
    expect(trace).toEqual(['activation-claim:activation-first', 'run-prepared:activation-first']);
  });

  it('holds the real file-backed serialiser across recovery, capacity, and dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-activation-scheduler-'));
    const trace: string[] = [];
    const firstRecoveryEntered = deferred<void>();
    const releaseFirstRecovery = deferred<void>();
    const firstCapacityEntered = deferred<void>();
    const releaseFirstCapacity = deferred<void>();
    const serialise = createFileActivationSchedulerSerialiser(root);
    try {
      const first = schedulerWithTrace('first', serialise, trace, {
        recoveryEntered: firstRecoveryEntered,
        releaseRecovery: releaseFirstRecovery,
        capacityEntered: firstCapacityEntered,
        releaseCapacity: releaseFirstCapacity,
      });
      const second = schedulerWithTrace('second', serialise, trace);

      const firstRun = first.runOnce({ maxProgress: 1 });
      await firstRecoveryEntered.promise;
      const secondRun = second.runOnce({ maxProgress: 1 });
      expect(trace).toEqual(['first:pause-gate', 'first:workspace-recovery']);

      releaseFirstRecovery.resolve();
      await firstCapacityEntered.promise;
      expect(trace).toEqual([
        'first:pause-gate',
        'first:workspace-recovery',
        'first:pause-gate',
        'first:active-recovery',
        'first:pause-gate',
        'first:pause-gate',
        'first:pause-gate',
        'first:child-reconciliation',
        'first:pause-gate',
        'first:terminal-reconciliation',
        'first:capacity-read',
      ]);

      releaseFirstCapacity.resolve();
      await firstRun;
      await secondRun;
      expect(trace).toEqual([
        'first:pause-gate',
        'first:workspace-recovery',
        'first:pause-gate',
        'first:active-recovery',
        'first:pause-gate',
        'first:pause-gate',
        'first:pause-gate',
        'first:child-reconciliation',
        'first:pause-gate',
        'first:terminal-reconciliation',
        'first:capacity-read',
        'first:terminal-reconciliation',
        'first:pause-gate',
        'first:activation-claim',
        'first:workspace-acquisition',
        'first:run-started',
        'second:pause-gate',
        'second:workspace-recovery',
        'second:pause-gate',
        'second:active-recovery',
        'second:pause-gate',
        'second:pause-gate',
        'second:pause-gate',
        'second:child-reconciliation',
        'second:pause-gate',
        'second:terminal-reconciliation',
        'second:capacity-read',
        'second:terminal-reconciliation',
        'second:pause-gate',
        'second:activation-claim',
        'second:workspace-acquisition',
        'second:run-started',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function serialiseInOrder(): ActivationSchedulerSerialiser {
  let prior: Promise<void> = Promise.resolve();
  return async <Value>(operation: () => Promise<Value>) => {
    const current = prior.then(operation);
    prior = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

function schedulerWithTrace(
  name: string,
  schedulerSerialiser: ActivationSchedulerSerialiser,
  trace: string[],
  barriers: {
    readonly recoveryEntered?: ReturnType<typeof deferred<void>>;
    readonly releaseRecovery?: ReturnType<typeof deferred<void>>;
    readonly capacityEntered?: ReturnType<typeof deferred<void>>;
    readonly releaseCapacity?: ReturnType<typeof deferred<void>>;
  } = {},
) {
  const pending = candidate(name);
  let listedForRecovery = false;
  return createActivationScheduler(
    {
      reconcileChildCompletions: async () => {
        trace.push(`${name}:child-reconciliation`);
      },
      listPendingActivations: async () => [pending],
      listWaiting: async () => [],
      acceptOutcome: async () => pending.workflow,
      markActivationStarted: async () => {
        trace.push(`${name}:activation-claim`);
        return pending.workflow;
      },
    },
    {
      recoverActive: async () => {
        trace.push(`${name}:active-recovery`);
        return [];
      },
      attempt: async () => {
        trace.push(`${name}:workspace-acquisition`);
        trace.push(`${name}:run-started`);
        return { runId: `run-${name}`, status: 'started' } as never;
      },
      list: async (activationId) => {
        if (activationId !== undefined) {
          trace.push(`${name}:terminal-reconciliation`);
          return [];
        }
        if (!listedForRecovery) {
          listedForRecovery = true;
          return [];
        }
        trace.push(`${name}:capacity-read`);
        barriers.capacityEntered?.resolve();
        await barriers.releaseCapacity?.promise;
        return [];
      },
    },
    { correlationsForWork: async () => [] } as never,
    { now: () => new Date('2026-08-29T00:00:00.000Z') },
    {
      ids: { next: () => `command-${name}` } as never,
      maxDispatches: 1,
      schedulerSerialiser,
      isDispatchPaused: async () => {
        trace.push(`${name}:pause-gate`);
        return false;
      },
      workspaceRecovery: {
        recover: async () => {
          trace.push(`${name}:workspace-recovery`);
          barriers.recoveryEntered?.resolve();
          await barriers.releaseRecovery?.promise;
          return { reclaimed: 0, failures: [] };
        },
      },
    },
  );
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
