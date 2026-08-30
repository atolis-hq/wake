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
  RunStatus,
  type ExecutionActivation,
  type ExecutionAttemptContext,
  type WorkspaceProvider,
} from '../../../src/execution/index.js';
import { type EventJournal } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
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

describe('ExecutionService', () => {
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
      (await journal.readAll(0)).filter((event) => event.eventType === 'execution.run-started'),
    ).toHaveLength(1);
    expect((await service.list(pendingActivation.activationId))[0]).toMatchObject({
      runId: started.runId,
      status: 'started',
    });

    const duplicate = await service.attempt(pendingActivation, context);
    expect(duplicate).toMatchObject({ runId: started.runId, status: 'started' });
    expect(handlerCalls).toBe(1);
    expect(
      (await journal.readAll(0)).filter((event) => event.eventType === 'execution.run-started'),
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
        async append(stream, expectedSequence, events) {
          if (events.some((event) => event.eventType === ExecutionEventType.RunLeaseRenewed)) {
            renewalEntered();
            await renewalBlocked;
          }
          return base.append(stream, expectedSequence, events);
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
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        ExecutionEventType.RunPreparationStarted,
        ExecutionEventType.RunLeaseClaimed,
      ]),
    );
    expect(events.map((event) => event.eventType)).not.toContain(ExecutionEventType.RunStarted);
    const preparation = events.find(
      (event) => event.eventType === ExecutionEventType.RunPreparationStarted,
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
  });

  it('does not start a cancelled Run after deferred workspace acquisition completes', async () => {
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
    let releaseAcquire!: () => void;
    const acquireReleased = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    let released = 0;
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
            await acquireReleased;
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
      },
    );
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
    releaseAcquire();

    await expect(attempt).resolves.toMatchObject({ status: RunStatus.Cancelled });
    expect(handlerCalls).toBe(0);
    expect(released).toBe(1);
    const eventTypes = (await journal.readAll(0)).map((event) => event.eventType);
    expect(eventTypes).toContain(ExecutionEventType.RunCancellationRequested);
    expect(eventTypes).toContain(ExecutionEventType.RunCancellationConfirmed);
    expect(eventTypes).toContain(ExecutionEventType.RunCancelled);
    expect(eventTypes).toContain(ExecutionEventType.ActivationReleased);
    expect(eventTypes).not.toContain(ExecutionEventType.RunStarted);
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
      async append(stream, expectedSequence, events) {
        if (
          renewBeforeStart &&
          events.some((event) => event.eventType === ExecutionEventType.RunStarted)
        ) {
          renewBeforeStart = false;
          await serviceRef.value!.renewLease('run-1', 'execution');
        }
        return base.append(stream, expectedSequence, events);
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
    const eventTypes = (await base.readAll(0)).map((event) => event.eventType);
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
    const eventTypes = (await fixture.journal.readAll(0)).map((event) => event.eventType);
    expect(eventTypes).toContain(ExecutionEventType.RunPreparationStarted);
    expect(eventTypes).toContain(ExecutionEventType.RunFailed);
    expect(eventTypes).toContain(ExecutionEventType.ActivationReleased);
    expect(eventTypes).not.toContain(ExecutionEventType.RunStarted);
  });

  it('returns the failed Run when activation cleanup cannot be persisted', async () => {
    const base = new InMemoryEventJournal(new FakeClock());
    const journal: EventJournal = {
      async append(stream, expectedSequence, events) {
        if (events.some((event) => event.eventType === ExecutionEventType.ActivationReleased))
          throw new Error('activation cleanup interrupted');
        return base.append(stream, expectedSequence, events);
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
    const eventTypes = (await base.readAll(0)).map((event) => event.eventType);
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
      expect((await fixture.journal.readAll(0)).map((event) => event.eventType)).toContain(
        'execution.workspace-cleanup-failed',
      );
    });
  });

  it('releases the workspace and clears cancellation after activation release fails', async () => {
    const base = new InMemoryEventJournal(new FakeClock());
    let failReleaseOnce = true;
    const releaseInterruptedJournal: EventJournal = {
      async append(stream, expectedSequence, events) {
        if (
          failReleaseOnce &&
          events.some((event) => event.eventType === 'execution.activation-released')
        ) {
          failReleaseOnce = false;
          throw new Error('activation release append interrupted');
        }
        return base.append(stream, expectedSequence, events);
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
      async append(stream, expectedSequence, events) {
        if (failStartOnce && events.some((event) => event.eventType === 'execution.run-started')) {
          failStartOnce = false;
          throw new Error('run start append interrupted');
        }
        return base.append(stream, expectedSequence, events);
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
