import { type EventJournal } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { activationId } from '../../../src/activities/contracts/identifiers.js';
import {
  ActivityExecutionKind,
  activityName,
  ActivityRegistry,
  type ActivationId,
  type ActivityName,
  type ActivityOrchestrationGroupId,
  type ActivityWorkflowInstanceId,
} from '../../../src/activities/index.js';
import {
  createExecutionService,
  decodeRunExecutionEvent,
  ExecutionEventType,
  ExecutionFailureCode,
  foldRun,
  RecoveryService,
  RunStatus,
  type ExecutionActivation,
  type ExecutionAttemptContext,
  type WorkspaceProvider,
} from '../../../src/execution/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import {} from '../../../src/work/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

function setup(workspace?: WorkspaceProvider, journal?: EventJournal, clock = new FakeClock()) {
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('implement'),
    inputSchema: z.object({ prompt: z.string() }).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  const eventJournal = journal ?? new InMemoryEventJournal(clock);
  const service = createExecutionService(
    eventJournal,
    registry,
    { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
    {
      clock,
      ids: new SequentialIds(),
      ...(workspace === undefined ? {} : { workspaces: workspace }),
    },
  );
  return { service, journal: eventJournal };
}

const activation = {
  activationId: activationId('workflow-1:activity:1'),
  ordinal: 1,
  activity: activityName('implement'),
  input: { prompt: 'ship' },
  execution: { workspace: 'none' as const },
  status: 'pending' as const,
};
const context = {
  workItemId: workId('1'),
  workflowInstanceId: workflowInstanceId('workflow-1'),
  orchestrationGroupId: orchestrationGroupId('group-1'),
  resources: [],
};

function repositoryResource() {
  return {
    resourceId: resId('repo'),
    kind: BuiltInResourceKind.Repository,
    externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
    capabilities: [],
  };
}

async function waitForRunStatus(
  service: ReturnType<typeof createExecutionService>,
  id: ExecutionActivation['activationId'],
  status: 'succeeded' | 'failed',
) {
  await vi.waitFor(async () => {
    expect((await service.list(id))[0]?.status).toBe(status);
  });
  return (await service.list(id))[0]!;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('ExecutionService', () => {
  it.each([ActivityExecutionKind.Agent, ActivityExecutionKind.Script])(
    'returns a durable preparing %s Run before workspace acquisition begins',
    async (executionKind) => {
      const registry = new ActivityRegistry();
      let handlerCalls = 0;
      const externalActivity = activityName(`${executionKind}-with-workspace`);
      registry.register({
        name: externalActivity,
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
        outcomeKinds: ['done'],
        resources: [],
        executionKind,
        handler: {
          async execute() {
            handlerCalls += 1;
            return { kind: 'done' };
          },
        },
      });
      let acquireEntered!: () => void;
      const acquired = new Promise<void>((resolve) => {
        acquireEntered = resolve;
      });
      let acquisitionStarted = false;
      let releaseAcquire!: () => void;
      const acquireReleased = new Promise<void>((resolve) => {
        releaseAcquire = resolve;
      });
      const clock = new FakeClock();
      const journal = new InMemoryEventJournal(clock);
      const service = createExecutionService(
        journal,
        registry,
        { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
        {
          clock,
          ids: new SequentialIds(),
          workspaces: {
            async acquire() {
              acquisitionStarted = true;
              acquireEntered();
              await acquireReleased;
              return {
                workspaceId: 'workspace-1',
                path: '/workspace-1',
                mode: 'read-only',
                async release() {},
              };
            },
          },
        },
      );
      const externalActivation = {
        ...activation,
        activity: externalActivity,
        execution: { workspace: 'read-only' as const },
      };

      const returned = await service.attempt(externalActivation, {
        ...context,
        resources: [repositoryResource()],
      });
      const acquisitionStartedBeforeReturn = acquisitionStarted;
      const eventTypesBeforeAcquisition = (await journal.readAll(0)).map(
        (event) => event.event.eventType,
      );
      await acquired;
      const locallyActiveDuringAcquisition = service.isLocallyActive('run-1');
      releaseAcquire();
      await waitForRunStatus(service, externalActivation.activationId, 'succeeded');

      expect(returned).toMatchObject({ status: RunStatus.Starting });
      expect(acquisitionStartedBeforeReturn).toBe(false);
      expect(locallyActiveDuringAcquisition).toBe(true);
      expect(eventTypesBeforeAcquisition).toContain(ExecutionEventType.RunPreparationStarted);
      expect(eventTypesBeforeAcquisition).not.toContain(ExecutionEventType.RunStarted);
      expect(handlerCalls).toBe(1);
      expect(service.isLocallyActive('run-1')).toBe(false);
    },
  );

  it('durably settles a detached agent workspace failure', async () => {
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('agent-workspace-failure'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Agent,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    let acquireEntered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      acquireEntered = resolve;
    });
    let rejectAcquire!: () => void;
    const acquireRejected = new Promise<void>((resolve) => {
      rejectAcquire = resolve;
    });
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const service = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            acquireEntered();
            await acquireRejected;
            throw new Error('workspace unavailable');
          },
        },
      },
    );
    const agentActivation = {
      ...activation,
      activity: activityName('agent-workspace-failure'),
      execution: { workspace: 'read-only' as const },
    };

    const attempt = service.attempt(agentActivation, {
      ...context,
      resources: [repositoryResource()],
    });
    await acquired;
    const result = await Promise.race([
      attempt.then((run) => ({ kind: 'resolved' as const, run })),
      new Promise<{ kind: 'pending' }>((resolve) => {
        setImmediate(() => resolve({ kind: 'pending' }));
      }),
    ]);
    const locallyActiveDuringAcquisition = service.isLocallyActive('run-1');

    rejectAcquire();
    const returned = await attempt;
    expect(result).toMatchObject({ kind: 'resolved', run: { status: RunStatus.Starting } });
    expect(returned.status).toBe(RunStatus.Starting);
    expect(locallyActiveDuringAcquisition).toBe(true);
    await expect(
      waitForRunStatus(service, agentActivation.activationId, 'failed'),
    ).resolves.toEqual(
      expect.objectContaining({
        runId: returned.runId,
        status: RunStatus.Failed,
        failure: expect.objectContaining({ message: 'workspace unavailable' }),
      }),
    );
    await vi.waitFor(() => expect(service.isLocallyActive(returned.runId)).toBe(false));
    expect((await journal.readAll(0)).map((event) => event.event.eventType)).toEqual(
      expect.arrayContaining([
        ExecutionEventType.RunPreparationStarted,
        ExecutionEventType.RunFailed,
        ExecutionEventType.ActivationReleased,
      ]),
    );
  });

  it('cancels a detached attempt before deferred workspace acquisition starts', async () => {
    const registry = new ActivityRegistry();
    const agentActivity = activityName('agent-deferred-cancellation');
    registry.register({
      name: agentActivity,
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Agent,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    let acquisitionStarted = false;
    const clock = new FakeClock();
    const service = createExecutionService(
      new InMemoryEventJournal(clock),
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            acquisitionStarted = true;
            throw new Error('workspace acquisition should not start');
          },
        },
      },
    );

    const preparing = await service.attempt(
      {
        ...activation,
        activity: agentActivity,
        execution: { workspace: 'read-only' as const },
      },
      { ...context, resources: [repositoryResource()] },
    );
    await service.requestCancellation(preparing.runId, 'operator');
    await service.shutdown();

    expect(acquisitionStarted).toBe(false);
    expect((await service.list())[0]).toMatchObject({
      runId: preparing.runId,
      status: RunStatus.Cancelled,
      cancellation: { reason: 'operator' },
    });
    expect(service.isLocallyActive(preparing.runId)).toBe(false);
  });

  it('propagates cancellation into an acquiring detached workspace and drains it', async () => {
    const registry = new ActivityRegistry();
    const scriptActivity = activityName('script-acquire-cancellation');
    registry.register({
      name: scriptActivity,
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Script,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    const acquireEntered = deferred<void>();
    let receivedSignal: AbortSignal | undefined;
    const clock = new FakeClock();
    const service = createExecutionService(
      new InMemoryEventJournal(clock),
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire(request) {
            receivedSignal = request.signal;
            acquireEntered.resolve();
            await new Promise<void>((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(request.signal.reason), {
                once: true,
              });
            });
            throw new Error('unreachable');
          },
        },
      },
    );

    const preparing = await service.attempt(
      {
        ...activation,
        activity: scriptActivity,
        execution: { workspace: 'read-only' as const },
      },
      { ...context, resources: [repositoryResource()] },
    );
    await acquireEntered.promise;
    await service.requestCancellation(preparing.runId, 'operator');
    await service.shutdown();

    expect(receivedSignal?.aborted).toBe(true);
    expect((await service.list())[0]).toMatchObject({
      runId: preparing.runId,
      status: RunStatus.Cancelled,
    });
  });

  it('shutdown cancels and drains a hung detached workspace acquisition exactly once', async () => {
    const registry = new ActivityRegistry();
    const agentActivity = activityName('agent-shutdown');
    registry.register({
      name: agentActivity,
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Agent,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    const acquireEntered = deferred<void>();
    const acquireAborted = deferred<void>();
    const clock = new FakeClock();
    const service = createExecutionService(
      new InMemoryEventJournal(clock),
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire(request) {
            acquireEntered.resolve();
            await new Promise<void>((_resolve, reject) => {
              request.signal.addEventListener(
                'abort',
                () => {
                  acquireAborted.resolve();
                  reject(request.signal.reason);
                },
                { once: true },
              );
            });
            throw new Error('unreachable');
          },
        },
      },
    );

    const preparing = await service.attempt(
      {
        ...activation,
        activity: agentActivity,
        execution: { workspace: 'read-only' as const },
      },
      { ...context, resources: [repositoryResource()] },
    );
    await acquireEntered.promise;
    const firstShutdown = service.shutdown();
    const secondShutdown = service.shutdown();
    await acquireAborted.promise;
    await Promise.all([firstShutdown, secondShutdown]);

    expect((await service.list())[0]).toMatchObject({
      runId: preparing.runId,
      status: RunStatus.Cancelled,
      cancellation: { reason: 'shutdown' },
    });
    await expect(
      service.attempt(
        { ...activation, activationId: activationId('closed-attempt'), activity: agentActivity },
        context,
      ),
    ).rejects.toThrow('Execution service is shut down');
  });

  it('shutdown aborts and drains deterministic workspace acquisition', async () => {
    const acquireEntered = deferred<void>();
    const acquireAborted = deferred<void>();
    const releaseAcquire = deferred<void>();
    const clock = new FakeClock();
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('deterministic-acquire-shutdown'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    const service = createExecutionService(
      new InMemoryEventJournal(clock),
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire(request) {
            acquireEntered.resolve();
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            acquireAborted.resolve();
            await releaseAcquire.promise;
            throw request.signal.reason;
          },
        },
      },
    );
    const attempt = service.attempt(
      {
        ...activation,
        activity: activityName('deterministic-acquire-shutdown'),
        execution: { workspace: 'read-only' as const },
      },
      { ...context, resources: [repositoryResource()] },
    );
    await acquireEntered.promise;
    let shutdownSettled = false;

    const shutdown = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await acquireAborted.promise;
    await Promise.resolve();
    const drainedBeforeAcquireSettled = shutdownSettled;
    releaseAcquire.resolve();
    await shutdown;

    expect(drainedBeforeAcquireSettled).toBe(false);
    await expect(attempt).resolves.toMatchObject({
      status: RunStatus.Cancelled,
      cancellation: { reason: 'shutdown' },
    });
  });

  it('owns shutdown cancellation when deterministic preparation completes after the first snapshot', async () => {
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const preparationAppendEntered = deferred<void>();
    const releasePreparationAppend = deferred<void>();
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (events.some((event) => event.eventType === ExecutionEventType.RunPreparationStarted)) {
          preparationAppendEntered.resolve();
          await releasePreparationAppend.promise;
        }
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('deterministic-late-prepare-shutdown'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    let acquisitionStarted = false;
    const service = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            acquisitionStarted = true;
            throw new Error('workspace acquisition should not start');
          },
        },
      },
    );
    const attempt = service.attempt(
      {
        ...activation,
        activity: activityName('deterministic-late-prepare-shutdown'),
        execution: { workspace: 'read-only' as const },
      },
      { ...context, resources: [repositoryResource()] },
    );
    await preparationAppendEntered.promise;

    const shutdown = service.shutdown();
    releasePreparationAppend.resolve();
    await shutdown;

    await expect(attempt).resolves.toMatchObject({
      status: RunStatus.Cancelled,
      cancellation: { reason: 'shutdown' },
    });
    expect(acquisitionStarted).toBe(false);
  });

  it('shutdown aborts a deterministic handler before cancellation persistence and drains completion', async () => {
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const cancellationAppendEntered = deferred<void>();
    const releaseCancellationAppend = deferred<void>();
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (
          events.some((event) => event.eventType === ExecutionEventType.RunCancellationRequested)
        ) {
          cancellationAppendEntered.resolve();
          await releaseCancellationAppend.promise;
        }
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const handlerEntered = deferred<void>();
    const handlerAborted = deferred<void>();
    const releaseHandler = deferred<void>();
    let signalAborted = false;
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('deterministic-handler-shutdown'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute(_invocation, executionContext) {
          handlerEntered.resolve();
          await new Promise<void>((resolve) => {
            executionContext.signal.addEventListener(
              'abort',
              () => {
                signalAborted = true;
                handlerAborted.resolve();
                resolve();
              },
              { once: true },
            );
          });
          await releaseHandler.promise;
          throw executionContext.signal.reason;
        },
      },
    });
    const service = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock, ids: new SequentialIds() },
    );

    const started = await service.attempt(
      { ...activation, activity: activityName('deterministic-handler-shutdown') },
      context,
    );
    await handlerEntered.promise;
    let shutdownSettled = false;
    const shutdown = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await cancellationAppendEntered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const abortedBeforeCancellationPersisted = signalAborted;
    releaseCancellationAppend.resolve();
    await handlerAborted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const drainedBeforeHandlerSettled = shutdownSettled;
    releaseHandler.resolve();
    await shutdown;

    expect(started.status).toBe(RunStatus.Started);
    expect(abortedBeforeCancellationPersisted).toBe(true);
    expect(drainedBeforeHandlerSettled).toBe(false);
    expect((await service.list())[0]).toMatchObject({
      status: RunStatus.Cancelled,
      cancellation: { reason: 'shutdown' },
    });
  });

  it('stops detached lease renewal before a recovery load that fails', async () => {
    vi.useFakeTimers();
    try {
      const registry = new ActivityRegistry();
      const agentActivity = activityName('agent-recovery-load-failure');
      registry.register({
        name: agentActivity,
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
        outcomeKinds: ['done'],
        resources: [],
        executionKind: ActivityExecutionKind.Agent,
        handler: { execute: async () => ({ kind: 'done' }) },
      });
      const clock = new FakeClock();
      const base = new InMemoryEventJournal(clock);
      const recoveryLoadFailed = deferred<void>();
      let runLoads = 0;
      const journal: EventJournal = {
        appendToStream: base.appendToStream.bind(base),
        async readStream(stream) {
          if (stream.id === 'run-1' && ++runLoads === 2) {
            recoveryLoadFailed.resolve();
            throw new Error('recovery load unavailable');
          }
          return base.readStream(stream);
        },
        readAll: base.readAll.bind(base),
        latestGlobalPosition: base.latestGlobalPosition.bind(base),
        waitForEventsAfter: base.waitForEventsAfter.bind(base),
        readLatest: base.readLatest?.bind(base),
        changeSignal: base.changeSignal,
      };
      const service = createExecutionService(
        journal,
        registry,
        {
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
          leaseDurationMs: 2,
          leaseRenewalIntervalMs: 1,
        },
        {
          clock,
          ids: new SequentialIds(),
          workspaces: { acquire: async () => Promise.reject(new Error('workspace unavailable')) },
        },
      );

      await service.attempt(
        {
          ...activation,
          activity: agentActivity,
          execution: { workspace: 'read-only' as const },
        },
        { ...context, resources: [repositoryResource()] },
      );
      await vi.advanceTimersByTimeAsync(0);
      await recoveryLoadFailed.promise;
      await Promise.resolve();
      clock.advance(1);
      await vi.advanceTimersByTimeAsync(1);

      expect((await base.readAll(0)).map(({ event }) => event.eventType)).not.toContain(
        ExecutionEventType.RunLeaseRenewed,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps detached local ownership through workspace release and cleanup diagnostics', async () => {
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('agent-cleanup-failure'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Agent,
      handler: { execute: async () => ({ kind: 'done' }) },
    });
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const diagnosticEntered = deferred<void>();
    const releaseDiagnostic = deferred<void>();
    const finalWorkerLoadEntered = deferred<void>();
    const serviceRef: { value?: ReturnType<typeof createExecutionService> } = {};
    let activeDuringWorkspaceRelease: boolean | undefined;
    let activeDuringCleanupDiagnostic: boolean | undefined;
    let activeDuringFinalWorkerLoad: boolean | undefined;
    let cleanupDiagnosticPersisted = false;
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        const recordsCleanupDiagnostic = events.some(
          (event) => event.eventType === ExecutionEventType.RunWorkspaceCleanupFailed,
        );
        if (recordsCleanupDiagnostic) {
          activeDuringCleanupDiagnostic = serviceRef.value!.isLocallyActive('run-1');
          diagnosticEntered.resolve();
          await releaseDiagnostic.promise;
        }
        const appended = await base.appendToStream(stream, expectedSequence, events);
        if (recordsCleanupDiagnostic) cleanupDiagnosticPersisted = true;
        return appended;
      },
      async readStream(stream) {
        if (cleanupDiagnosticPersisted && stream.id === 'run-1') {
          activeDuringFinalWorkerLoad = serviceRef.value!.isLocallyActive('run-1');
          finalWorkerLoadEntered.resolve();
        }
        return base.readStream(stream);
      },
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const service = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            return {
              workspaceId: 'workspace-1',
              path: '/workspace-1',
              mode: 'read-only',
              async release() {
                activeDuringWorkspaceRelease = service.isLocallyActive('run-1');
                throw new Error('workspace release failed');
              },
            };
          },
        },
      },
    );
    serviceRef.value = service;
    const cleanupActivation = {
      ...activation,
      activity: activityName('agent-cleanup-failure'),
      execution: { workspace: 'read-only' as const },
    };

    const preparing = await service.attempt(cleanupActivation, {
      ...context,
      resources: [repositoryResource()],
    });
    await diagnosticEntered.promise;
    const activeWhileDiagnosticPending = service.isLocallyActive(preparing.runId);
    releaseDiagnostic.resolve();
    await finalWorkerLoadEntered.promise;
    await vi.waitFor(() => expect(service.isLocallyActive(preparing.runId)).toBe(false));

    expect(activeDuringWorkspaceRelease).toBe(true);
    expect(activeDuringCleanupDiagnostic).toBe(true);
    expect(activeWhileDiagnosticPending).toBe(true);
    expect(activeDuringFinalWorkerLoad).toBe(true);
    expect((await service.list(cleanupActivation.activationId))[0]).toMatchObject({
      status: RunStatus.Succeeded,
    });
    expect(await base.readAll(0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            eventType: ExecutionEventType.RunWorkspaceCleanupFailed,
            payload: { message: 'workspace release failed' },
          }),
        }),
      ]),
    );
  });

  it('returns a durable started Run before a pending handler completes', async () => {
    const registry = new ActivityRegistry();
    let handlerEntered!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerCalls = 0;
    registry.register({
      name: activityName('pending'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute() {
          handlerCalls += 1;
          handlerEntered();
          await handlerReleased;
          return { kind: 'done' };
        },
      },
    });
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock: new FakeClock(), ids: new SequentialIds() },
    );
    const pendingActivation = { ...activation, activity: activityName('pending') };

    const started = await service.attempt(pendingActivation, context);
    await handlerStarted;

    expect(started.status).toBe('started');
    expect(
      (await journal.readAll(0)).filter(
        (event) => event.event.eventType === 'execution.run-started',
      ),
    ).toHaveLength(1);
    expect((await service.list(pendingActivation.activationId))[0]).toMatchObject({
      runId: started.runId,
      status: 'started',
    });

    const duplicate = await service.attempt(pendingActivation, context);
    expect(duplicate).toMatchObject({ runId: started.runId, status: 'started' });
    expect(handlerCalls).toBe(1);
    expect(
      (await journal.readAll(0)).filter(
        (event) => event.event.eventType === 'execution.run-started',
      ),
    ).toHaveLength(1);

    releaseHandler();
    await vi.waitFor(async () => {
      expect((await service.list(pendingActivation.activationId))[0]?.status).toBe('succeeded');
    });
  });

  it('drains an in-flight lease renewal before recording a successful terminal outcome', async () => {
    vi.useFakeTimers();
    try {
      const clock = new FakeClock();
      const base = new InMemoryEventJournal(clock);
      let releaseRenewal!: () => void;
      const renewalBlocked = new Promise<void>((resolve) => {
        releaseRenewal = resolve;
      });
      let renewalEntered!: () => void;
      const renewalStarted = new Promise<void>((resolve) => {
        renewalEntered = resolve;
      });
      const journal: EventJournal = {
        async appendToStream(stream, expectedSequence, events) {
          if (events.some((event) => event.eventType === ExecutionEventType.RunLeaseRenewed)) {
            renewalEntered();
            await renewalBlocked;
          }
          return base.appendToStream(stream, expectedSequence, events);
        },
        readStream: base.readStream.bind(base),
        readAll: base.readAll.bind(base),
        latestGlobalPosition: base.latestGlobalPosition.bind(base),
        waitForEventsAfter: base.waitForEventsAfter.bind(base),
        readLatest: base.readLatest?.bind(base),
        changeSignal: base.changeSignal,
      };
      const registry = new ActivityRegistry();
      let releaseHandler!: () => void;
      registry.register({
        name: activityName('renewal-race'),
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
        outcomeKinds: ['done'],
        resources: [],
        executionKind: ActivityExecutionKind.Deterministic,
        handler: {
          async execute() {
            await new Promise<void>((resolve) => {
              releaseHandler = resolve;
            });
            return { kind: 'done' };
          },
        },
      });
      const service = createExecutionService(
        journal,
        registry,
        {
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
          leaseDurationMs: 2,
          leaseRenewalIntervalMs: 1,
        },
        { clock, ids: new SequentialIds() },
      );
      const raceActivation = { ...activation, activity: activityName('renewal-race') };

      await service.attempt(raceActivation, context);
      clock.advance(1);
      await vi.advanceTimersByTimeAsync(1);
      await renewalStarted;
      releaseHandler();
      await Promise.resolve();
      expect((await service.list(raceActivation.activationId))[0]?.status).toBe('started');

      releaseRenewal();
      await vi.runAllTimersAsync();
      await expect(
        waitForRunStatus(service, raceActivation.activationId, 'succeeded'),
      ).resolves.toMatchObject({
        status: 'succeeded',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms cancellation that arrives while failed preparation waits for lease renewal', async () => {
    vi.useFakeTimers();
    try {
      const clock = new FakeClock();
      const base = new InMemoryEventJournal(clock);
      let releaseRenewal!: () => void;
      const renewalBlocked = new Promise<void>((resolve) => {
        releaseRenewal = resolve;
      });
      let renewalEntered!: () => void;
      const renewalStarted = new Promise<void>((resolve) => {
        renewalEntered = resolve;
      });
      let recoveryLoaded!: () => void;
      const recoveryLoad = new Promise<void>((resolve) => {
        recoveryLoaded = resolve;
      });
      let runLoads = 0;
      const journal: EventJournal = {
        async appendToStream(stream, expectedSequence, events) {
          if (events.some((event) => event.eventType === ExecutionEventType.RunLeaseRenewed)) {
            renewalEntered();
            await renewalBlocked;
          }
          return base.appendToStream(stream, expectedSequence, events);
        },
        async readStream(stream) {
          const events = await base.readStream(stream);
          if (stream.id === 'run-1' && ++runLoads === 2) recoveryLoaded();
          return events;
        },
        readAll: base.readAll.bind(base),
        latestGlobalPosition: base.latestGlobalPosition.bind(base),
        waitForEventsAfter: base.waitForEventsAfter.bind(base),
        readLatest: base.readLatest?.bind(base),
        changeSignal: base.changeSignal,
      };
      let rejectAcquire!: () => void;
      const acquireRejected = new Promise<void>((resolve) => {
        rejectAcquire = resolve;
      });
      let acquireEntered!: () => void;
      const acquired = new Promise<void>((resolve) => {
        acquireEntered = resolve;
      });
      const fixture = setup(
        {
          async acquire() {
            acquireEntered();
            await acquireRejected;
            throw new Error('workspace unavailable');
          },
        },
        journal,
        clock,
      );
      const workspaceActivation = { ...activation, execution: { workspace: 'read-only' as const } };
      const workspaceContext = { ...context, resources: [repositoryResource()] };

      const attempt = fixture.service.attempt(workspaceActivation, workspaceContext);
      await acquired;
      clock.advance(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await renewalStarted;
      rejectAcquire();
      await recoveryLoad;
      await Promise.resolve();
      await fixture.service.requestCancellation('run-1', 'operator');
      releaseRenewal();

      await expect(attempt).resolves.toMatchObject({ status: RunStatus.Cancelled });
      const eventTypes = (await base.readAll(0)).map((event) => event.event.eventType);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          ExecutionEventType.RunCancellationRequested,
          ExecutionEventType.RunCancellationConfirmed,
          ExecutionEventType.RunCancelled,
        ]),
      );
      expect(
        eventTypes.filter(
          (eventType) =>
            eventType === ExecutionEventType.RunCancellationRequested ||
            eventType === ExecutionEventType.RunCancellationConfirmed ||
            eventType === ExecutionEventType.RunCancelled,
        ),
      ).toEqual([
        ExecutionEventType.RunCancellationRequested,
        ExecutionEventType.RunCancellationConfirmed,
        ExecutionEventType.RunCancelled,
      ]);
      expect(eventTypes).not.toContain(ExecutionEventType.RunFailed);
      expect(eventTypes).not.toContain(ExecutionEventType.RunStarted);
      expect(fixture.service.isLocallyActive('run-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates one Run and records a validated outcome separately', async () => {
    const fixture = setup();
    const started = await fixture.service.attempt(activation, context);
    expect(started.status).toBe('started');
    const run = await waitForRunStatus(fixture.service, activation.activationId, 'succeeded');
    expect(run).toMatchObject({
      activationId: activation.activationId,
      activity: activation.activity,
      workflowInstanceId: context.workflowInstanceId,
      orchestrationGroupId: context.orchestrationGroupId,
      attempt: 1,
      status: 'succeeded',
      outcome: { kind: 'done' },
    });
  });
  it('validates input before run.started', async () => {
    await expect(setup().service.attempt({ ...activation, input: {} }, context)).rejects.toThrow(
      /input invalid/,
    );
  });
  it('does not allocate a workspace for none', async () => {
    let calls = 0;
    await setup({
      async acquire() {
        calls++;
        throw new Error('unexpected');
      },
    }).service.attempt(activation, context);
    expect(calls).toBe(0);
  });

  it('appends preparation and the initial lease in one fresh-run journal write', async () => {
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const appendCalls: {
      readonly expectedSequence: number;
      readonly eventTypes: readonly string[];
    }[] = [];
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        appendCalls.push({ expectedSequence, eventTypes: events.map((event) => event.eventType) });
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const fixture = setup(undefined, journal, clock);

    await fixture.service.attempt(activation, context);

    expect(
      appendCalls.filter((call) =>
        call.eventTypes.includes(ExecutionEventType.RunPreparationStarted),
      ),
    ).toEqual([
      {
        expectedSequence: 0,
        eventTypes: [ExecutionEventType.RunPreparationStarted, ExecutionEventType.RunLeaseClaimed],
      },
    ]);
  });

  it('settles request-only cancellation when deferred workspace acquisition rejects', async () => {
    const registry = new ActivityRegistry();
    let handlerCalls = 0;
    registry.register({
      name: activityName('request-only-cancellation'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute() {
          handlerCalls += 1;
          return { kind: 'done' };
        },
      },
    });
    let acquireEntered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      acquireEntered = resolve;
    });
    let rejectAcquire!: () => void;
    const acquireRejected = new Promise<void>((resolve) => {
      rejectAcquire = resolve;
    });
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const service = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            acquireEntered();
            await acquireRejected;
            throw new Error('workspace unavailable');
          },
        },
      },
    );
    const cancelledActivation = {
      ...activation,
      activity: activityName('request-only-cancellation'),
      execution: { workspace: 'read-only' as const },
    };

    const attempt = service.attempt(cancelledActivation, {
      ...context,
      resources: [repositoryResource()],
    });
    await acquired;
    expect(service.isLocallyActive('run-1')).toBe(true);
    await service.requestCancellation('run-1', 'operator');
    rejectAcquire();

    await expect(attempt).resolves.toMatchObject({ status: RunStatus.Cancelled });
    const eventTypes = (await journal.readAll(0)).map((event) => event.event.eventType);
    expect(
      eventTypes.filter(
        (eventType) =>
          eventType === ExecutionEventType.RunCancellationRequested ||
          eventType === ExecutionEventType.RunCancellationConfirmed ||
          eventType === ExecutionEventType.RunCancelled,
      ),
    ).toEqual([
      ExecutionEventType.RunCancellationRequested,
      ExecutionEventType.RunCancellationConfirmed,
      ExecutionEventType.RunCancelled,
    ]);
    expect(eventTypes).not.toContain(ExecutionEventType.RunStarted);
    expect(eventTypes).not.toContain(ExecutionEventType.RunFailed);
    expect(eventTypes).toContain(ExecutionEventType.ActivationReleased);
    expect(eventTypes).not.toContain(ExecutionEventType.RunWorkspaceCleanupFailed);
    expect(handlerCalls).toBe(0);
    expect(service.isLocallyActive('run-1')).toBe(false);
  });

  it('records failure after four sequence-winning lease renewals', async () => {
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const serviceRef: { value?: ReturnType<typeof createExecutionService> } = {};
    let injectedRenewals = 0;
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (
          injectedRenewals === 0 &&
          events.some((event) => event.eventType === ExecutionEventType.RunFailed)
        ) {
          for (let index = 0; index < 4; index += 1) {
            clock.advance(1);
            await serviceRef.value!.renewLease('run-1', 'execution');
            injectedRenewals += 1;
          }
        }
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const fixture = setup(
      {
        async acquire() {
          throw new Error('workspace unavailable');
        },
      },
      journal,
      clock,
    );
    serviceRef.value = fixture.service;

    await expect(
      fixture.service.attempt(
        { ...activation, execution: { workspace: 'read-only' } },
        { ...context, resources: [repositoryResource()] },
      ),
    ).resolves.toMatchObject({ status: RunStatus.Failed });

    const eventTypes = (await base.readAll(0)).map((event) => event.event.eventType);
    expect(injectedRenewals).toBe(4);
    expect(
      eventTypes.filter((eventType) => eventType === ExecutionEventType.RunLeaseRenewed),
    ).toHaveLength(4);
    expect(
      eventTypes.filter((eventType) => eventType === ExecutionEventType.RunFailed),
    ).toHaveLength(1);
    expect(eventTypes).not.toContain(ExecutionEventType.RunStarted);
    expect(eventTypes).toContain(ExecutionEventType.ActivationReleased);
    expect(fixture.service.isLocallyActive('run-1')).toBe(false);
  });

  it('persists and leases a starting Run while workspace acquisition is blocked', async () => {
    const clock = new FakeClock();
    let acquireEntered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      acquireEntered = resolve;
    });
    let releaseAcquire!: () => void;
    const acquireReleased = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    const fixture = setup(
      {
        async acquire() {
          acquireEntered();
          await acquireReleased;
          return {
            workspaceId: 'workspace-1',
            path: '/workspace-1',
            mode: 'read-only',
            async release() {},
          };
        },
      },
      undefined,
      clock,
    );
    const workspaceActivation = { ...activation, execution: { workspace: 'read-only' as const } };
    const workspaceContext = { ...context, resources: [repositoryResource()] };

    const attempt = fixture.service.attempt(workspaceActivation, workspaceContext);
    await acquired;

    const events = await fixture.journal.readAll(0);
    expect(fixture.service.isLocallyActive('run-1')).toBe(true);
    const recovery = new RecoveryService(
      fixture.journal,
      clock,
      {
        async inspect() {
          throw new Error('locally active preparation must not recover');
        },
      },
      {
        validateOutcome() {
          return { kind: 'done' };
        },
      },
    );
    clock.advance(60_001);
    await expect(
      recovery.recoverActive('resident', fixture.service.isLocallyActive),
    ).resolves.toEqual([]);
    expect(events.map((event) => event.event.eventType)).toEqual(
      expect.arrayContaining([
        ExecutionEventType.RunPreparationStarted,
        ExecutionEventType.RunLeaseClaimed,
      ]),
    );
    expect(events.map((event) => event.event.eventType)).not.toContain(
      ExecutionEventType.RunStarted,
    );
    const preparation = events.find(
      (event) => event.event.eventType === ExecutionEventType.RunPreparationStarted,
    )!;
    expect(
      foldRun((await fixture.journal.readStream(preparation.stream)).map(decodeRunExecutionEvent)),
    ).toMatchObject({ status: RunStatus.Starting });

    clock.advance(1);
    releaseAcquire();
    const started = await attempt;

    expect(started).toMatchObject({
      status: RunStatus.Started,
      workspace: { path: '/workspace-1', mode: 'read-only' },
    });
    expect(new Date(started.executionStartedAt!).getTime()).toBeGreaterThan(
      new Date(started.startedAt).getTime(),
    );
    await vi.waitFor(() => expect(fixture.service.isLocallyActive(started.runId)).toBe(false));
  });

  it('returns a terminally cancelled Run when deferred workspace acquisition rejects', async () => {
    const registry = new ActivityRegistry();
    let handlerCalls = 0;
    registry.register({
      name: activityName('cancelled-before-start'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute() {
          handlerCalls += 1;
          return { kind: 'done' };
        },
      },
    });
    let acquireEntered!: () => void;
    const acquired = new Promise<void>((resolve) => {
      acquireEntered = resolve;
    });
    let rejectAcquire!: () => void;
    const acquireRejected = new Promise<void>((resolve) => {
      rejectAcquire = resolve;
    });
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const serviceRef: { value?: ReturnType<typeof createExecutionService> } = {};
    let activeWhenActivationReleased: boolean | undefined;
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (events.some((event) => event.eventType === ExecutionEventType.ActivationReleased))
          activeWhenActivationReleased = serviceRef.value!.isLocallyActive('run-1');
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const service = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      {
        clock,
        ids: new SequentialIds(),
        workspaces: {
          async acquire() {
            acquireEntered();
            await acquireRejected;
            throw new Error('workspace unavailable');
          },
        },
      },
    );
    serviceRef.value = service;
    const cancelledActivation = {
      ...activation,
      activity: activityName('cancelled-before-start'),
      execution: { workspace: 'read-only' as const },
    };

    const attempt = service.attempt(cancelledActivation, {
      ...context,
      resources: [repositoryResource()],
    });
    await acquired;
    await service.requestCancellation('run-1', 'operator');
    await service.confirmCancellation('run-1');
    rejectAcquire();

    await expect(attempt).resolves.toMatchObject({ status: RunStatus.Cancelled });
    expect(handlerCalls).toBe(0);
    expect(activeWhenActivationReleased).toBe(true);
    expect(service.isLocallyActive('run-1')).toBe(false);
    const eventTypes = (await journal.readAll(0)).map((event) => event.event.eventType);
    expect(eventTypes).toContain(ExecutionEventType.RunCancellationRequested);
    expect(eventTypes).toContain(ExecutionEventType.RunCancellationConfirmed);
    expect(eventTypes).toContain(ExecutionEventType.RunCancelled);
    expect(eventTypes).toContain(ExecutionEventType.ActivationReleased);
    expect(eventTypes).not.toContain(ExecutionEventType.RunStarted);
    expect(eventTypes).not.toContain(ExecutionEventType.RunFailed);
    expect(eventTypes).not.toContain(ExecutionEventType.RunWorkspaceCleanupFailed);
  });

  it('retries the prepared Run start when a lease renewal wins the append race', async () => {
    const registry = new ActivityRegistry();
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    registry.register({
      name: activityName('start-race'),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute() {
          await handlerReleased;
          return { kind: 'done' };
        },
      },
    });
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const serviceRef: { value?: ReturnType<typeof createExecutionService> } = {};
    let renewBeforeStart = true;
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (
          renewBeforeStart &&
          events.some((event) => event.eventType === ExecutionEventType.RunStarted)
        ) {
          renewBeforeStart = false;
          await serviceRef.value!.renewLease('run-1', 'execution');
        }
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    serviceRef.value = createExecutionService(
      journal,
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock, ids: new SequentialIds() },
    );
    const service = serviceRef.value;

    const started = await service.attempt(
      { ...activation, activity: activityName('start-race') },
      context,
    );

    expect(started.status).toBe(RunStatus.Started);
    const eventTypes = (await base.readAll(0)).map((event) => event.event.eventType);
    expect(eventTypes.filter((type) => type === ExecutionEventType.RunStarted)).toHaveLength(1);
    expect(eventTypes).toContain(ExecutionEventType.RunLeaseRenewed);
    expect(eventTypes).not.toContain(ExecutionEventType.RunFailed);

    releaseHandler();
    await waitForRunStatus(service, activation.activationId, 'succeeded');
  });

  it('records a failed starting Run and releases activation when workspace acquisition rejects', async () => {
    const fixture = setup({
      async acquire() {
        throw new Error('workspace unavailable');
      },
    });
    const workspaceActivation = { ...activation, execution: { workspace: 'read-only' as const } };
    const result = await fixture.service.attempt(workspaceActivation, {
      ...context,
      resources: [repositoryResource()],
    });

    expect(result).toMatchObject({ status: RunStatus.Failed });
    const eventTypes = (await fixture.journal.readAll(0)).map((event) => event.event.eventType);
    expect(eventTypes).toContain(ExecutionEventType.RunPreparationStarted);
    expect(eventTypes).toContain(ExecutionEventType.RunFailed);
    expect(eventTypes).toContain(ExecutionEventType.ActivationReleased);
    expect(eventTypes).not.toContain(ExecutionEventType.RunStarted);
  });

  it('returns the failed Run when activation cleanup cannot be persisted', async () => {
    const base = new InMemoryEventJournal(new FakeClock());
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (events.some((event) => event.eventType === ExecutionEventType.ActivationReleased))
          throw new Error('activation cleanup interrupted');
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const fixture = setup(
      {
        async acquire() {
          throw new Error('workspace unavailable');
        },
      },
      journal,
    );
    const result = await fixture.service.attempt(
      { ...activation, execution: { workspace: 'read-only' as const } },
      { ...context, resources: [repositoryResource()] },
    );

    expect(result).toMatchObject({ status: RunStatus.Failed });
    const eventTypes = (await base.readAll(0)).map((event) => event.event.eventType);
    expect(eventTypes).toContain(ExecutionEventType.RunFailed);
    expect(eventTypes).not.toContain(ExecutionEventType.ActivationReleased);
  });

  it('passes the newly allocated Run ID to workspace acquisition', async () => {
    let acquiredRunId: string | undefined;
    const fixture = setup({
      async acquire(request) {
        acquiredRunId = request.runId;
        return {
          workspaceId: 'workspace-1',
          path: '/workspace-1',
          mode: 'read-only',
          async release() {},
        };
      },
    });

    await fixture.service.attempt(
      { ...activation, execution: { workspace: 'read-only' } },
      {
        ...context,
        resources: [
          {
            resourceId: resId('repo'),
            kind: BuiltInResourceKind.Repository,
            externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
            capabilities: [],
          },
        ],
      },
    );

    expect(acquiredRunId).toBe('run-1');
  });

  it('records workspace cleanup failure without failing a completed run', async () => {
    const fixture = setup({
      async acquire() {
        return {
          workspaceId: 'workspace-1',
          path: '/workspace-1',
          mode: 'read-only',
          async release() {
            throw new Error('EACCES: workspace still in use');
          },
        };
      },
    });
    const started = await fixture.service.attempt(
      { ...activation, execution: { workspace: 'read-only' } },
      {
        ...context,
        resources: [
          {
            resourceId: resId('repo'),
            kind: BuiltInResourceKind.Repository,
            externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
            capabilities: [],
          },
        ],
      },
    );

    expect(started.status).toBe('started');
    await waitForRunStatus(fixture.service, activation.activationId, 'succeeded');
    await vi.waitFor(async () => {
      expect((await fixture.journal.readAll(0)).map((event) => event.event.eventType)).toContain(
        'execution.workspace-cleanup-failed',
      );
    });
  });

  it('releases the workspace and clears cancellation after activation release fails', async () => {
    const base = new InMemoryEventJournal(new FakeClock());
    let failReleaseOnce = true;
    const releaseInterruptedJournal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (
          failReleaseOnce &&
          events.some((event) => event.eventType === 'execution.activation-released')
        ) {
          failReleaseOnce = false;
          throw new Error('activation release append interrupted');
        }
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    let released = 0;
    const fixture = setup(
      {
        async acquire() {
          return {
            workspaceId: 'workspace-1',
            path: '/workspace-1',
            mode: 'read-only',
            async release() {
              released += 1;
            },
          };
        },
      },
      releaseInterruptedJournal,
    );
    const workspaceActivation = { ...activation, execution: { workspace: 'read-only' as const } };
    const workspaceContext = {
      ...context,
      resources: [
        {
          resourceId: resId('repo'),
          kind: BuiltInResourceKind.Repository,
          externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
          capabilities: [],
        },
      ],
    };

    const started = await fixture.service.attempt(workspaceActivation, workspaceContext);
    await waitForRunStatus(fixture.service, workspaceActivation.activationId, 'succeeded');

    await vi.waitFor(() => expect(released).toBe(1));
    await expect(fixture.service.requestCancellation(started.runId, 'operator')).rejects.toThrow(
      'Run is not active',
    );
  });

  it('releases an allocated workspace when persisting run start is interrupted, then allows retry', async () => {
    const base = new InMemoryEventJournal(new FakeClock());
    let failStartOnce = true;
    const interruptedJournal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (failStartOnce && events.some((event) => event.eventType === 'execution.run-started')) {
          failStartOnce = false;
          throw new Error('run start append interrupted');
        }
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    let acquired = 0;
    let released = 0;
    const fixture = setup(
      {
        async acquire() {
          acquired += 1;
          return {
            workspaceId: `workspace-${acquired}`,
            path: `/workspace-${acquired}`,
            mode: 'read-only',
            async release() {
              released += 1;
            },
          };
        },
      },
      interruptedJournal,
    );
    const workspaceActivation = { ...activation, execution: { workspace: 'read-only' as const } };
    const workspaceContext = {
      ...context,
      resources: [
        {
          resourceId: resId('repo'),
          kind: BuiltInResourceKind.Repository,
          externalKey: { adapter: 'github', key: 'atolis-hq/wake' },
          capabilities: [],
        },
      ],
    };

    await expect(
      fixture.service.attempt(workspaceActivation, workspaceContext),
    ).resolves.toMatchObject({
      status: RunStatus.Failed,
    });
    expect({ acquired, released }).toEqual({ acquired: 1, released: 1 });

    const retry = await fixture.service.attempt(workspaceActivation, workspaceContext);
    expect(retry.status).toBe('started');
    await vi.waitFor(async () => {
      expect(
        (await fixture.service.list(workspaceActivation.activationId)).find(
          (run) => run.runId === retry.runId,
        )?.status,
      ).toBe(RunStatus.Succeeded);
    });
    expect({ acquired, released }).toEqual({ acquired: 2, released: 2 });
  });
  it('rejects an unregistered execution runner pool', async () => {
    await expect(
      setup().service.attempt({ ...activation, execution: { runnerPool: 'premium' } }, context),
    ).rejects.toThrow(/runner pool/);
  });

  it('preserves valid owner-specific output and rejects invalid owner output end to end', async () => {
    const registry = new ActivityRegistry();
    registry.register({
      name: activityName('score'),
      inputSchema: z.object({ value: z.number() }).strict(),
      outcomeSchema: z
        .object({
          kind: z.literal('scored'),
          data: z.object({ score: z.number() }).strict(),
        })
        .strict(),
      outcomeKinds: ['scored'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute(invocation) {
          return {
            kind: 'scored',
            data: { score: invocation.input.value === 7 ? 7 : ('invalid' as never) },
          };
        },
      },
    });
    const service = createExecutionService(
      new InMemoryEventJournal(new FakeClock()),
      registry,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock: new FakeClock(), ids: new SequentialIds() },
    );
    const scoreActivation = {
      ...activation,
      activity: activityName('score'),
      input: { value: 7 },
    };

    expect((await service.attempt(scoreActivation, context)).status).toBe('started');
    await expect(
      waitForRunStatus(service, scoreActivation.activationId, 'succeeded'),
    ).resolves.toMatchObject({
      status: 'succeeded',
      outcome: { kind: 'scored', data: { score: 7 } },
    });
    const invalidActivation = {
      ...scoreActivation,
      activationId: activationId('score-invalid'),
      input: { value: 0 },
    };
    expect((await service.attempt(invalidActivation, context)).status).toBe('started');
    await expect(
      waitForRunStatus(service, invalidActivation.activationId, 'failed'),
    ).resolves.toMatchObject({
      status: 'failed',
      failure: {
        kind: ExecutionFailureCode.Unexpected,
        details: { sourceKind: 'Error' },
      },
    });
  });

  it('publishes branded execution commands end to end', () => {
    expectTypeOf<ExecutionActivation['activationId']>().toEqualTypeOf<ActivationId>();
    expectTypeOf<ExecutionActivation['activity']>().toEqualTypeOf<ActivityName>();
    expectTypeOf<
      ExecutionAttemptContext['workflowInstanceId']
    >().toEqualTypeOf<ActivityWorkflowInstanceId>();
    expectTypeOf<
      ExecutionAttemptContext['orchestrationGroupId']
    >().toEqualTypeOf<ActivityOrchestrationGroupId>();
  });
});
