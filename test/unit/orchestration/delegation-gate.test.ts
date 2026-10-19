import { expect, it, vi } from 'vitest';
import { DelegationGate } from '../../../src/orchestration/application/delegation-gate.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import type { WorkService } from '../../../src/work/index.js';
import { snapshotOf } from '../../support/delivery-snapshot.js';

function gate(view: Partial<WorkflowInstanceView>, items: Record<string, object | null>) {
  const repository = {
    load: async () => ({ view: { workItemId: 'item', ...view } as WorkflowInstanceView }),
  };
  return new DelegationGate(repository as never, workOf(items));
}

function workOf(items: Record<string, object | null>) {
  const deliverySnapshot = vi.fn(async () => snapshotOf((id) => items[id] ?? null));
  return { deliverySnapshot } as unknown as WorkService & {
    deliverySnapshot: typeof deliverySnapshot;
  };
}

it('keeps existing freeze semantics for standalone work', async () => {
  const standalone = gate({}, { item: { state: 'open', frozen: true } });
  expect(await standalone.fenced('w' as never)).toBe(false);
});

it('holds frozen delegated work, frozen ancestors and frozen fenced parents', async () => {
  const delegation = { parentWorkItemId: 'root', rootWorkItemId: 'root', ancestors: ['root'] };
  const child = gate(
    {},
    { item: { state: 'open', delegation }, root: { state: 'open', frozen: true } },
  );
  expect(await child.fenced('w' as never)).toBe(true);
  const fenced = gate(
    { delegationFence: { activationId: 'a' } as never },
    { item: { state: 'open', frozen: true } },
  );
  expect(await fenced.fenced('w' as never)).toBe(true);
});

it('admits a batch against one Work synchronisation, and none when nothing is unfenced', async () => {
  const delegation = { parentWorkItemId: 'root', rootWorkItemId: 'root', ancestors: ['root'] };
  const work = workOf({
    root: { state: 'open', frozen: true },
    held: { state: 'open', delegation },
    free: { state: 'open' },
  });
  const batch = new DelegationGate({} as never, work);
  const views = [
    ...Array.from({ length: 300 }, () => ({ workItemId: 'free' })),
    { workItemId: 'held' },
    { workItemId: 'fenced', delegationFence: { activationId: 'a' } },
  ] as WorkflowInstanceView[];
  const admitted = await batch.filterAvailable(views, (view) => view);
  expect(admitted).toHaveLength(300);
  expect(work.deliverySnapshot).toHaveBeenCalledTimes(1);

  await batch.filterAvailable([views.at(-1)!, null], (view) => view);
  expect(work.deliverySnapshot).toHaveBeenCalledTimes(1);
});
