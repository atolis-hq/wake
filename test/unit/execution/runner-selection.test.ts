import { describe, expect, it, vi } from 'vitest';
import { workId } from '../../support/identities.js';

import { createEventData, EventActorKind, EventSourceKind } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import {
  activationId,
  ActivityRegistry,
  agentActivityDefinition,
} from '../../../src/activities/index.js';
import * as executionServiceModule from '../../../src/execution/application/execution-service.js';
import {
  createExecutionService,
  ExecutionEventType,
  runId,
  RunnerRegistry,
  RunStatus,
  runStream,
  type ExecutionConfig,
  type Runner,
  type RunView,
} from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import {} from '../../../src/work/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';

describe('Execution runner selection', () => {
  it('resolves the runner from the activation runner pool', async () => {
    const standard = runner('standard');
    const premium = runner('premium');
    const service = fixture(
      new RunnerRegistry({ standard: ['standard'], premium: ['premium'] }, { standard, premium }),
    );

    await service.attempt(activation('premium'), context());

    expect(premium.calls).toBe(1);
    expect(standard.calls).toBe(0);
  });

  it('falls back to the default runner pool when a stage declares none', async () => {
    const standard = runner('standard');
    const service = fixture(new RunnerRegistry({ standard: ['standard'] }, { standard }));

    await service.attempt(activation(), context());

    expect(standard.calls).toBe(1);
  });

  it('records the resolved runner name, model, and effort on the Run', async () => {
    const standard = runner('standard');
    const service = fixture(new RunnerRegistry({ standard: ['standard'] }, { standard }));

    const run = await service.attempt(activation(), context());

    expect(run).toMatchObject({
      runner: { name: 'standard', model: 'test-model', effort: 'high' },
    });
  });

  it('forwards the selected runner model and effort to the runner request', async () => {
    const standard = capturingRunner('standard');
    const service = fixture(new RunnerRegistry({ standard: ['standard'] }, { standard }));

    await service.attempt(activation(), context());

    expect(standard.requests).toEqual([
      expect.objectContaining({ model: 'test-model', effort: 'high' }),
    ]);
  });

  it('rejects a runner pool with no registered runner', async () => {
    const service = fixture(new RunnerRegistry({ standard: ['missing'] }, {}));

    await expect(service.attempt(activation(), context())).rejects.toThrow(/not registered/);
  });

  it('falls sideways to the next runner-pool candidate when the preferred runner is quota-ineligible', async () => {
    const sonnet = runner('sonnet');
    const codexMini = runner('codex-mini');
    const service = fixture(
      new RunnerRegistry(
        { standard: ['sonnet', 'codex-mini'] },
        { sonnet, 'codex-mini': codexMini },
      ),
    );

    await service.attempt(activation(), context(new Set(['sonnet'])));

    expect(codexMini.calls).toBe(1);
    expect(sonnet.calls).toBe(0);
  });

  it('persists a successful runner session and token usage on the Run', async () => {
    const standard: Runner = {
      async start() {
        return {
          result: Promise.resolve({
            transport: 'succeeded',
            output: 'DONE',
            runner: 'standard',
            sessionId: 'session-1',
            tokenUsage: { input: 10, output: 20, costUsd: 0.03 },
          }),
          async cancel() {},
        };
      },
    };
    const service = fixture(new RunnerRegistry({ standard: ['standard'] }, { standard }));

    await service.attempt(activation(), context());
    const run = await finishedRun(service, activation().activationId);

    expect(run).toMatchObject({
      agent: {
        metadata: {
          sessionId: 'session-1',
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.03,
        },
      },
    });
  });

  it('forwards the newest same-adapter durable session from this activation', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'prior-standard', 'fake', 'session-1');
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(activation(), context());

    expect(standard.requests).toEqual([expect.objectContaining({ resumeSessionId: 'session-1' })]);
  });

  it('starts fresh when the selected runner does not support session resume', async () => {
    const standard = capturingRunner('standard', false);
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'prior-standard', 'fake', 'session-1');
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(activation(), context());

    expect(standard.requests).toEqual([
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    ]);
  });

  it('starts fresh when a different configured runner is selected', async () => {
    const replacement = capturingRunner('replacement');
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'paused-runner', 'fake', 'session-1', {
      runnerName: 'paused',
    });
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['replacement'] }, { replacement }),
      {
        paused: {
          kind: 'fake',
          model: 'test-model',
          effort: 'high',
          runnerTimeouts: testRunnerTimeouts,
          args: [],
        },
        replacement: {
          kind: 'fake',
          model: 'test-model',
          effort: 'high',
          runnerTimeouts: testRunnerTimeouts,
          args: [],
        },
      },
    );

    await service.attempt(activation(), context());

    expect(replacement.requests).toEqual([
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    ]);
  });

  it('forwards the accumulated usage baseline for a resumed session', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'prior-standard', 'fake', 'session-1', {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    });
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(activation(), context());

    expect(standard.requests).toEqual([
      expect.objectContaining({
        resumeSessionId: 'session-1',
        usageBaseline: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      }),
    ]);
  });

  it('sums only scoped terminal runs with finite metadata counters for the resumed session', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    const implement = { ...activation(), stage: 'implement' };
    await seedPriorRun(journal, implement, 'implement-first', 'fake', 'session-1', {
      inputTokens: 10,
      outputTokens: 0,
      cacheWriteTokens: 0,
    });
    await seedPriorRun(journal, implement, 'implement-second', 'fake', 'session-1', {
      inputTokens: 0,
      outputTokens: 20,
      cacheReadTokens: 5,
    });
    await seedPriorRun(journal, implement, 'started-session-1', 'fake', 'session-1', {
      inputTokens: 1_000,
      outputTokens: 1_000,
      testStatus: 'started',
    });
    await seedPriorRun(journal, implement, 'ambiguous-session-1', 'fake', 'session-1', {
      inputTokens: 1_000,
      outputTokens: 1_000,
      testStatus: 'ambiguous',
    });
    await seedPriorRun(journal, implement, 'a-terminal-session-2', 'fake', 'session-2', {
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    await seedPriorRun(journal, implement, 'different-cli', 'other-cli', 'session-1', {
      inputTokens: 100,
      outputTokens: 100,
    });
    await seedPriorRun(
      journal,
      { ...activation(), stage: 'design' },
      'different-stage',
      'fake',
      'session-1',
      { inputTokens: 100, outputTokens: 100 },
    );
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(
      { ...implement, activationId: activationId('agent:implement:next'), ordinal: 2 },
      { ...context(), sessionPolicy: 'resume-stage' },
    );

    expect(standard.requests).toEqual([
      expect.objectContaining({
        resumeSessionId: 'session-1',
        usageBaseline: { input: 10, output: 20 },
      }),
    ]);
  });

  it('resumes the newest same-CLI session when a primary stage is re-entered', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    const first = {
      ...activation(),
      activationId: activationId('agent:implement:1'),
      stage: 'implement',
    };
    const returnedToStage = {
      ...first,
      activationId: activationId('agent:implement:2'),
      ordinal: 2,
    };
    await seedPriorRun(journal, first, 'first-implement', 'fake', 'session-first');
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(returnedToStage, {
      ...context(),
      sessionPolicy: 'resume-stage',
    });

    expect(standard.requests).toEqual([
      expect.objectContaining({ resumeSessionId: 'session-first' }),
    ]);
  });

  it('starts a fresh session for a watch workflow', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'watch-prior', 'fake', 'watch-session');
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(activation(), { ...context(), sessionPolicy: 'fresh' });

    expect(standard.requests).toEqual([
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    ]);
    expect(standard.requests).toEqual([
      expect.not.objectContaining({ usageBaseline: expect.anything() }),
    ]);
  });

  it('suppresses the entire baseline when matched history has non-finite required counters', () => {
    const baseline = (
      executionServiceModule as unknown as {
        readonly usageBaselineFor?: (
          runs: readonly RunView[],
          cli: string | undefined,
          sessionId: string | undefined,
        ) => unknown;
      }
    ).usageBaselineFor;
    const run = (metadata: Readonly<Record<string, string | number | boolean | null>>) => ({
      ...resumeRun('prior', RunStatus.Failed, 'session-1', '2026-08-11T12:00:00.000Z', 1),
      agent: { outcome: 'FAILED' as const, displayBody: 'failed', metadata },
    });

    expect(baseline).toBeTypeOf('function');
    expect(
      baseline?.(
        [
          run({
            sessionId: 'session-1',
            inputTokens: 10,
            outputTokens: 'invalid',
            cacheReadTokens: Number.NaN,
            cacheWriteTokens: Number.POSITIVE_INFINITY,
          }),
          run({ sessionId: 'session-1', inputTokens: 0, outputTokens: 20, cacheReadTokens: 5 }),
        ],
        'fake',
        'session-1',
      ),
    ).toBeUndefined();
  });

  it('does not forward a baseline when matched terminal history lacks valid required counters', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'complete-history', 'fake', 'session-1', {
      inputTokens: 10,
      outputTokens: 20,
    });
    await seedPriorRun(journal, activation(), 'missing-input-history', 'fake', 'session-1', {
      outputTokens: 20,
    });
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(activation(), context());

    expect(standard.requests).toEqual([expect.objectContaining({ resumeSessionId: 'session-1' })]);
    expect(standard.requests[0]).not.toEqual(
      expect.objectContaining({ usageBaseline: expect.anything() }),
    );
  });

  it('omits incomplete cache baselines but rejects malformed cache history', () => {
    const baseline = executionServiceModule.usageBaselineFor;
    const run = (
      id: string,
      metadata: Readonly<Record<string, string | number | boolean | null>>,
    ) => ({
      ...resumeRun(id, RunStatus.Failed, 'session-1', '2026-08-11T12:00:00.000Z', 1),
      agent: { outcome: 'FAILED' as const, displayBody: 'failed', metadata },
    });

    expect(
      baseline(
        [
          run('with-cache', {
            sessionId: 'session-1',
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 5,
          }),
          run('without-cache', { sessionId: 'session-1', inputTokens: 10, outputTokens: 20 }),
        ],
        'fake',
        'session-1',
      ),
    ).toEqual({ input: 20, output: 40 });
    expect(
      baseline(
        [
          run('missing-cache', { sessionId: 'session-1', inputTokens: 10, outputTokens: 20 }),
          run('negative-cache-after-missing', {
            sessionId: 'session-1',
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: -1,
          }),
        ],
        'fake',
        'session-1',
      ),
    ).toBeUndefined();
    expect(
      baseline(
        [
          run('negative-cache', {
            sessionId: 'session-1',
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: -1,
          }),
        ],
        'fake',
        'session-1',
      ),
    ).toBeUndefined();
    expect(
      baseline(
        [run('negative-input', { sessionId: 'session-1', inputTokens: -1, outputTokens: 20 })],
        'fake',
        'session-1',
      ),
    ).toBeUndefined();
    expect(
      baseline(
        [
          run('malformed-cache', {
            sessionId: 'session-1',
            inputTokens: 10,
            outputTokens: 20,
            cacheWriteTokens: 'invalid',
          }),
        ],
        'fake',
        'session-1',
      ),
    ).toBeUndefined();
  });

  it('does not forward a usage baseline when no durable session is selected', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'prior-without-session', 'fake', undefined, {
      inputTokens: 10,
      outputTokens: 20,
    });
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(activation(), context());

    expect(standard.requests).toEqual([
      expect.not.objectContaining({ usageBaseline: expect.anything() }),
    ]);
  });

  it('does not resume absent sessions or sessions from another adapter or activation', async () => {
    const standard = capturingRunner('standard');
    const journal = new InMemoryEventJournal(new FakeClock());
    await seedPriorRun(journal, activation(), 'prior-other-cli', 'codex-cli', 'wrong-cli');
    await seedPriorRun(journal, activation(), 'prior-without-session', 'fake');
    await seedPriorRun(
      journal,
      { ...activation(), activationId: activationId('agent:other') },
      'prior-other-activation',
      'fake',
      'wrong-activation',
    );
    const service = fixtureWithJournal(
      journal,
      new RunnerRegistry({ standard: ['standard'] }, { standard }),
    );

    await service.attempt(activation(), context());

    expect(standard.requests).toEqual([
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
    ]);
  });

  it('selects only conclusively terminal sessions and breaks newest ties deterministically', () => {
    const select = (
      executionServiceModule as unknown as {
        readonly resumeSessionIdFor?: (
          runs: readonly RunView[],
          cli: string | undefined,
        ) => string | undefined;
      }
    ).resumeSessionIdFor;
    const runs = [
      resumeRun('old', RunStatus.Failed, 'session-old', '2026-08-11T11:00:00.000Z', 1),
      resumeRun('inflight', RunStatus.Started, 'session-inflight', undefined, 99),
      resumeRun(
        'unresolved',
        RunStatus.Ambiguous,
        'session-unresolved',
        '2026-08-11T13:00:00.000Z',
        99,
      ),
      resumeRun('attempt-five', RunStatus.Cancelled, 'session-five', '2026-08-11T12:00:00.000Z', 5),
      resumeRun('tie-a', RunStatus.Failed, 'session-a', '2026-08-11T12:00:00.000Z', 6),
      resumeRun('tie-z', RunStatus.Failed, 'session-z', '2026-08-11T12:00:00.000Z', 6),
    ];

    expect(select).toBeTypeOf('function');
    expect(select?.(runs, 'fake')).toBe('session-z');
  });
});

function fixture(runners: RunnerRegistry) {
  return fixtureWithJournal(new InMemoryEventJournal(new FakeClock()), runners);
}

function fixtureWithJournal(
  journal: InMemoryEventJournal,
  runners: RunnerRegistry,
  agentRunners: NonNullable<ExecutionConfig['agentRunners']> = standardAgentRunners,
) {
  const registry = new ActivityRegistry();
  registry.register(agentActivityDefinition);
  return createExecutionService(
    journal,
    registry,
    {
      agentRunners,
      runnerPools: { standard: ['standard'], premium: ['premium'] },
      defaultRunnerPool: 'standard',
    },
    {
      clock: new FakeClock(),
      ids: new SequentialIds(),
      runners,
    },
  );
}

const testRunnerTimeouts = { idleMs: 600_000, hardMs: 7_200_000, cancellationGraceMs: 30_000 };

const standardAgentRunners = {
  standard: {
    kind: 'fake' as const,
    model: 'test-model',
    effort: 'high',
    runnerTimeouts: testRunnerTimeouts,
    args: [],
  },
} satisfies NonNullable<ExecutionConfig['agentRunners']>;

function capturingRunner(
  name: string,
  supportsSessionResume = true,
): Runner & { readonly requests: readonly unknown[] } {
  const requests: unknown[] = [];
  return {
    supportsSessionResume,
    get requests() {
      return requests;
    },
    async start(request) {
      requests.push(request);
      return {
        result: Promise.resolve({ transport: 'succeeded', output: 'DONE', runner: name }),
        async cancel() {},
      };
    },
  };
}

async function seedPriorRun(
  journal: InMemoryEventJournal,
  activationValue: ReturnType<typeof activation> & { readonly stage?: string },
  id: string,
  cli: string,
  sessionId?: string,
  usage?:
    | (Readonly<Record<string, string | number | boolean | null>> & {
        readonly testStatus?: 'started' | 'ambiguous';
        readonly runnerName?: string;
      })
    | undefined,
) {
  const clock = new FakeClock();
  const stream = runStream(runId(id));
  const { testStatus: status = 'failed', runnerName = 'standard', ...metadata } = usage ?? {};
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: clock.now().toISOString(),
      correlationId: 'group-1',
      causationId: activationValue.activationId,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      payload: {
        activationId: activationValue.activationId,
        activity: activationValue.activity,
        ...(activationValue.stage === undefined ? {} : { stage: activationValue.stage }),
        workflowInstanceId: workflowInstanceId('workflow-1'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        attempt: 1,
        startedAt: clock.now().toISOString(),
        runner: { name: runnerName, cli },
      },
    }),
    createEventData({
      eventId: `${id}:result`,
      eventType: ExecutionEventType.RunRunnerResultReported,
      occurredAt: clock.now().toISOString(),
      correlationId: 'group-1',
      causationId: activationValue.activationId,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      payload: {
        transport: 'failed',
        agent: {
          outcome: 'FAILED',
          displayBody: 'failed',
          metadata: { ...(sessionId === undefined ? {} : { sessionId }), ...metadata },
        },
      },
    }),
    ...(status === 'started'
      ? []
      : status === 'ambiguous'
        ? [
            createEventData({
              eventId: `${id}:ambiguous`,
              eventType: ExecutionEventType.RunAmbiguous,
              occurredAt: clock.now().toISOString(),
              correlationId: 'group-1',
              causationId: activationValue.activationId,
              actor: { kind: EventActorKind.System, id: 'test' },
              source: { kind: EventSourceKind.Internal, id: 'test' },
              payload: { reason: 'ambiguous', finishedAt: clock.now().toISOString() },
            }),
          ]
        : [
            createEventData({
              eventId: `${id}:failed`,
              eventType: ExecutionEventType.RunFailed,
              occurredAt: clock.now().toISOString(),
              correlationId: 'group-1',
              causationId: activationValue.activationId,
              actor: { kind: EventActorKind.System, id: 'test' },
              source: { kind: EventSourceKind.Internal, id: 'test' },
              payload: {
                failure: { kind: 'unexpected-execution-failure', message: 'failed' },
                finishedAt: clock.now().toISOString(),
              },
            }),
          ]),
  ]);
}

function resumeRun(
  id: string,
  status: RunStatus,
  sessionId: string,
  finishedAt: string | undefined,
  attempt: number,
): RunView {
  return {
    runId: runId(id),
    activationId: activationId('agent:default'),
    activity: agentActivityDefinition.name,
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    attempt,
    status,
    ambiguityAttempts: 0,
    escalated: status === RunStatus.Ambiguous,
    startedAt: '2026-08-11T10:00:00.000Z',
    runner: { name: 'standard', cli: 'fake' },
    ...(finishedAt === undefined ? {} : { finishedAt }),
    agent: { outcome: 'FAILED', displayBody: 'failed', metadata: { sessionId } },
  };
}

function activation(runnerPool?: string) {
  return {
    activationId: activationId(`agent:${runnerPool ?? 'default'}`),
    ordinal: 1,
    activity: agentActivityDefinition.name,
    input: { prompt: 'ship' },
    execution: {
      workspace: 'none' as const,
      ...(runnerPool === undefined ? {} : { runnerPool }),
    },
    status: 'pending' as const,
  };
}

function context(ineligibleRunners?: ReadonlySet<string>) {
  return {
    workItemId: workId('00000000000000000000000002'),
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    resources: [],
    ...(ineligibleRunners === undefined ? {} : { ineligibleRunners }),
  };
}

function runner(name: string): Runner & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async start() {
      calls++;
      return {
        result: Promise.resolve({ transport: 'succeeded' as const, output: 'DONE', runner: name }),
        async cancel() {},
      };
    },
  };
}

async function finishedRun(
  service: ReturnType<typeof createExecutionService>,
  id: ReturnType<typeof activation>['activationId'],
): Promise<RunView> {
  await vi.waitFor(async () => {
    expect((await service.list(id))[0]?.status).toBe(RunStatus.Succeeded);
  });
  return (await service.list(id))[0]!;
}
