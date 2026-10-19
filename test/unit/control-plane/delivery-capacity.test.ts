import { expect, it } from 'vitest';
import { deliveryCapacity } from '../../../src/control-plane/domain/delivery-capacity.js';
import type { RunView } from '../../../src/execution/index.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

it('counts parent, child and watch Runs against their common root, but no waiting workflow (DC-26)', async () => {
  const root = workId('work-root');
  const child = workId('work-child');
  const workflows = [
    { workItemId: root, workflowInstanceId: 'parent' },
    { workItemId: child, workflowInstanceId: 'child' },
    { workItemId: child, workflowInstanceId: 'watch', parentWorkflowInstanceId: 'child' },
  ] as WorkflowInstanceView[];
  const work = {
    async get(id: string) {
      return {
        state: 'open',
        ...(id === child
          ? {
              delegation: {
                parentWorkItemId: root,
                rootWorkItemId: root,
                ancestors: [root],
              },
            }
          : {}),
      };
    },
  };
  const runs = [{ workflowInstanceId: 'watch', status: 'started' }] as RunView[];
  const full = await deliveryCapacity(workflows, runs, work, async () => 1);
  expect([...full.full]).toEqual([root]);
  expect(full.roots.get(child)).toBe(root);
  const idle = await deliveryCapacity(workflows, [], work, async () => 1);
  expect(idle.full.size).toBe(0);
});

it('reads ancestry only for live work and limits only for roots with active Runs', async () => {
  const read: string[] = [];
  const limited: string[] = [];
  const work = {
    async get(id: string) {
      read.push(id);
      return { state: 'open' };
    },
  };
  const workflows = [
    { workItemId: 'done', workflowInstanceId: 'a', status: 'completed' },
    { workItemId: 'idle', workflowInstanceId: 'b', status: 'waiting' },
    { workItemId: 'busy', workflowInstanceId: 'c', status: 'active' },
  ] as WorkflowInstanceView[];
  const runs = [{ workflowInstanceId: 'c', status: 'started' }] as RunView[];
  await deliveryCapacity(workflows, runs, work, async (id) => {
    limited.push(id);
    return 1;
  });
  expect(read.sort()).toEqual(['busy', 'idle']);
  expect(limited).toEqual(['busy']);
});

it('marks descendants unavailable when their root is frozen, cancelled or absent', async () => {
  const root = workId('work-root');
  const child = workId('work-child');
  for (const unavailable of [{ state: 'open', frozen: true }, { state: 'cancelled' }, null]) {
    const work = {
      async get(id: string) {
        return id === root
          ? unavailable
          : {
              state: 'open',
              delegation: { parentWorkItemId: root, rootWorkItemId: root, ancestors: [root] },
            };
      },
    };
    const capacity = await deliveryCapacity(
      [{ workItemId: child }] as WorkflowInstanceView[],
      [],
      work,
      undefined,
    );
    expect(capacity.unavailable.has(child)).toBe(true);
  }
});
