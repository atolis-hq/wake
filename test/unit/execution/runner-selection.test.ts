import { describe, expect, it } from 'vitest';
import { workId } from '../../support/identities.js';

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
  type Runner,
  type RunView,
} from '../../../src/execution/index.js';
import { createEventDraft, EventActorKind, EventSourceKind } from '../../../src/kernel/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
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

    const run = await service.attempt(activation(), context());

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

function fixtureWithJournal(journal: InMemoryEventJournal, runners: RunnerRegistry) {
  const registry = new ActivityRegistry();
  registry.register(agentActivityDefinition);
  return createExecutionService(
    journal,
    registry,
    {
      agentRunners: {
        standard: { kind: 'fake', model: 'test-model', effort: 'high', timeoutMs: 1_000, args: [] },
      },
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

function capturingRunner(name: string): Runner & { readonly requests: readonly unknown[] } {
  const requests: unknown[] = [];
  return {
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
  activationValue: ReturnType<typeof activation>,
  id: string,
  cli: string,
  sessionId?: string,
) {
  const clock = new FakeClock();
  const stream = runStream(runId(id));
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: clock.now().toISOString(),
      correlationId: 'group-1',
      causationId: activationValue.activationId,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      stream,
      payload: {
        activationId: activationValue.activationId,
        activity: activationValue.activity,
        workflowInstanceId: workflowInstanceId('workflow-1'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        attempt: 1,
        startedAt: clock.now().toISOString(),
        runner: { name: 'standard', cli },
      },
    }),
    createEventDraft({
      eventId: `${id}:result`,
      eventType: ExecutionEventType.RunRunnerResultReported,
      occurredAt: clock.now().toISOString(),
      correlationId: 'group-1',
      causationId: activationValue.activationId,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      stream,
      payload: {
        transport: 'failed',
        agent: {
          outcome: 'FAILED',
          displayBody: 'failed',
          metadata: sessionId === undefined ? {} : { sessionId },
        },
      },
    }),
    createEventDraft({
      eventId: `${id}:failed`,
      eventType: ExecutionEventType.RunFailed,
      occurredAt: clock.now().toISOString(),
      correlationId: 'group-1',
      causationId: activationValue.activationId,
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      stream,
      payload: {
        failure: { kind: 'unexpected-execution-failure', message: 'failed' },
        finishedAt: clock.now().toISOString(),
      },
    }),
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
