import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { activationId } from '../../src-next/activities/contracts/identifiers.js';
import { activityName } from '../../src-next/activities/index.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ActivityRegistry } from '../../src-next/activities/index.js';
import { createExecutionService } from '../../src-next/execution/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { workItemId } from '../../src-next/work/index.js';
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
  workItemId: workItemId('work-1'),
  workflowInstanceId: workflowInstanceId('workflow-1'),
  orchestrationGroupId: orchestrationGroupId('group-1'),
  resources: [],
};

describe('ExecutionService', () => {
  it('creates one Run and records a validated outcome separately', async () => {
    const run = await setup().attempt(activation, context);
    expect(run).toMatchObject({
      activationId: activation.activationId,
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
});
