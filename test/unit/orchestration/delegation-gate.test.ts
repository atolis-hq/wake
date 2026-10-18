import { expect, it } from 'vitest';
import { DelegationGate } from '../../../src/orchestration/application/delegation-gate.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import type { WorkService } from '../../../src/work/index.js';

function gate(view: Partial<WorkflowInstanceView>, items: Record<string, object | null>) {
  const repository = {
    load: async () => ({ view: { workItemId: 'item', ...view } as WorkflowInstanceView }),
  };
  const work = { get: async (id: string) => items[id] ?? null } as unknown as WorkService;
  return new DelegationGate(repository as never, work);
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
