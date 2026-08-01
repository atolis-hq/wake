import { describe, expect, it } from 'vitest';
import { workId } from '../support/identities.js';

import {
  ActivityRegistry,
  agentActivityDefinition,
  activationId,
} from '../../src-next/activities/index.js';
import {
  createExecutionService,
  RunnerRegistry,
  type Runner,
} from '../../src-next/execution/index.js';
import { workflowInstanceId, orchestrationGroupId } from '../../src-next/orchestration/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import {} from '../../src-next/work/index.js';
import { FakeClock, SequentialIds } from '../e2e/support/world.js';

describe('Execution runner selection', () => {
  it('resolves the runner from the activation tier', async () => {
    const standard = runner('standard');
    const premium = runner('premium');
    const service = fixture(
      new RunnerRegistry({ standard: ['standard'], premium: ['premium'] }, { standard, premium }),
    );

    await service.attempt(activation('premium'), context());

    expect(premium.calls).toBe(1);
    expect(standard.calls).toBe(0);
  });

  it('falls back to the default tier when a stage declares none', async () => {
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

  it('rejects a tier with no registered runner', async () => {
    const service = fixture(new RunnerRegistry({ standard: ['missing'] }, {}));

    await expect(service.attempt(activation(), context())).rejects.toThrow(/not registered/);
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
      tiers: { standard: ['standard'], premium: ['premium'] },
      defaultTier: 'standard',
    },
    {
      clock: new FakeClock(),
      ids: new SequentialIds(),
      runners,
    },
  );
}

function activation(tier?: string) {
  return {
    activationId: activationId(`agent:${tier ?? 'default'}`),
    ordinal: 1,
    activity: agentActivityDefinition.name,
    input: { prompt: 'ship' },
    execution: { workspace: 'none' as const, ...(tier === undefined ? {} : { tier }) },
    status: 'pending' as const,
  };
}
function context() {
  return {
    workItemId: workId('00000000000000000000000002'),
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    resources: [],
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
