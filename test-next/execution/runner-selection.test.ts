import { describe, expect, it } from 'vitest';
import { workId } from '../support/identities.js';

import {
  activationId,
  ActivityRegistry,
  agentActivityDefinition,
} from '../../src-next/activities/index.js';
import {
  createExecutionService,
  RunnerRegistry,
  type Runner,
} from '../../src-next/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../src-next/orchestration/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import {} from '../../src-next/work/index.js';
import { FakeClock, SequentialIds } from '../e2e/support/world.js';

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
      sessionId: 'session-1',
      tokenUsage: { input: 10, output: 20, costUsd: 0.03 },
    });
  });
});

function fixture(runners: RunnerRegistry) {
  const registry = new ActivityRegistry();
  registry.register(agentActivityDefinition);
  return createExecutionService(
    new InMemoryEventJournal(new FakeClock()),
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
