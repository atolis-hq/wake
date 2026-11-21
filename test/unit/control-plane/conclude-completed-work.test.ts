import { describe, expect, it } from 'vitest';
import { createActivationScheduler } from '../../../src/control-plane/index.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { FakeClock } from '../../e2e/support/world.js';

type Instance = {
  workflowInstanceId: string;
  workItemId: string;
  status: string;
  concludesWork?: true | undefined;
};

function setup(
  instances: Instance[],
  primary: Record<string, string>,
  states: Record<string, string>,
) {
  const closed: string[] = [];
  const scheduler = createActivationScheduler(
    {
      reconcileChildCompletions: async () => undefined,
      listPendingActivations: async () => [],
      listWaiting: async () => [],
      listAll: async () => instances as unknown as readonly WorkflowInstanceView[],
      getPrimaryWorkflowInstanceId: async (workItemId: string) => primary[workItemId],
      acceptOutcome: async () => ({}) as never,
      markActivationStarted: async () => ({}) as never,
    },
    { attempt: async () => ({}) as never, list: async () => [] },
    { correlationsForWork: async () => [] } as never,
    new FakeClock(),
    {
      ids: { next: () => 'command-1' } as never,
      work: {
        get: async (id: string) =>
          states[id] === undefined ? null : { state: states[id] as never },
        deliverySnapshot: async () => ({}) as never,
      },
      conclusion: {
        async closeWork(id: string) {
          closed.push(id);
          states[id] = 'closed';
        },
      },
    },
  );
  return { scheduler, closed };
}

const done = (id: string, extra: Partial<Instance> = {}): Instance => ({
  workflowInstanceId: `wf-${id}`,
  workItemId: `work-${id}`,
  status: 'completed',
  concludesWork: true,
  ...extra,
});

describe('concluding completed work', () => {
  it('leaves work open when the workflow made no declaration', async () => {
    const { scheduler, closed } = setup(
      [done('a', { concludesWork: undefined })],
      { 'work-a': 'wf-a' },
      { 'work-a': 'open' },
    );
    await scheduler.maintain!();
    expect(closed).toEqual([]);
  });

  it('closes the work item exactly once across repeated passes', async () => {
    const { scheduler, closed } = setup([done('a')], { 'work-a': 'wf-a' }, { 'work-a': 'open' });
    await scheduler.maintain!();
    await scheduler.maintain!();
    expect(closed).toEqual(['work-a']);
  });

  it('waits for the final done: a still-running instance does not close the work', async () => {
    const { scheduler, closed } = setup(
      [done('a', { status: 'active' })],
      { 'work-a': 'wf-a' },
      { 'work-a': 'open' },
    );
    await scheduler.maintain!();
    expect(closed).toEqual([]);
  });

  it('is a no-op when the issue was already closed externally', async () => {
    const { scheduler, closed } = setup([done('a')], { 'work-a': 'wf-a' }, { 'work-a': 'closed' });
    await scheduler.maintain!();
    expect(closed).toEqual([]);
  });

  it('ignores a declaration on a non-primary instance', async () => {
    const { scheduler, closed } = setup(
      [done('a')],
      { 'work-a': 'wf-other' },
      { 'work-a': 'open' },
    );
    await scheduler.maintain!();
    expect(closed).toEqual([]);
  });

  it('closes through the policy even when a blocked sibling exists', async () => {
    const { scheduler, closed } = setup(
      [done('a'), { workflowInstanceId: 'wf-sib', workItemId: 'work-a', status: 'blocked' }],
      { 'work-a': 'wf-a' },
      { 'work-a': 'open' },
    );
    await scheduler.maintain!();
    expect(closed).toEqual(['work-a']);
  });
});
