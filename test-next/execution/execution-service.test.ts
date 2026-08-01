import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { activationId } from '../../src-next/activities/contracts/identifiers.js';
import { activityName } from '../../src-next/activities/index.js';
import { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { workId } from '../support/identities.js';
import {
  ActivityExecutionKind,
  ActivityRegistry,
  type ActivationId,
  type ActivityName,
  type ActivityOrchestrationGroupId,
  type ActivityWorkflowInstanceId,
} from '../../src-next/activities/index.js';
import {
  createExecutionService,
  ExecutionFailureCode,
  type ExecutionActivation,
  type ExecutionAttemptContext,
} from '../../src-next/execution/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import {} from '../../src-next/work/index.js';
import { FakeClock, SequentialIds } from '../e2e/support/world.js';

function setup(workspace?: { acquire: (request: unknown) => Promise<never> }) {
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
  return createExecutionService(
    new InMemoryEventJournal(new FakeClock()),
    registry,
    { tiers: { standard: ['fake'] }, defaultTier: 'standard' },
    {
      clock: new FakeClock(),
      ids: new SequentialIds(),
      ...(workspace === undefined ? {} : { workspaces: workspace }),
    },
  );
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

describe('ExecutionService', () => {
  it('creates one Run and records a validated outcome separately', async () => {
    const run = await setup().attempt(activation, context);
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
    await expect(setup().attempt({ ...activation, input: {} }, context)).rejects.toThrow(
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
    }).attempt(activation, context);
    expect(calls).toBe(0);
  });
  it('rejects an unregistered execution tier', async () => {
    await expect(
      setup().attempt({ ...activation, execution: { tier: 'premium' } }, context),
    ).rejects.toThrow(/tier/);
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
      { tiers: { standard: ['fake'] }, defaultTier: 'standard' },
      { clock: new FakeClock(), ids: new SequentialIds() },
    );
    const scoreActivation = {
      ...activation,
      activity: activityName('score'),
      input: { value: 7 },
    };

    await expect(service.attempt(scoreActivation, context)).resolves.toMatchObject({
      status: 'succeeded',
      outcome: { kind: 'scored', data: { score: 7 } },
    });
    await expect(
      service.attempt(
        { ...scoreActivation, activationId: activationId('score-invalid'), input: { value: 0 } },
        context,
      ),
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
