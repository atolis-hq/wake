import { expect, it } from 'vitest';
import { DispatchPolicy } from '../../../src-next/control-plane/index.js';

it('E2E-CONTROL-001: alternates eligible WorkItems by ready position under a global budget', () => {
  const selected = new DispatchPolicy({ maxDispatches: 2 }).select([
    {
      workItemId: 'work-a',
      activationId: 'activation-a',
      requestedPosition: 2,
      hasActiveRun: false,
      cancelled: false,
    },
    {
      workItemId: 'work-b',
      activationId: 'activation-b',
      requestedPosition: 1,
      hasActiveRun: false,
      cancelled: false,
    },
  ]);
  expect(selected.map(({ workItemId }) => workItemId)).toEqual(['work-b', 'work-a']);
});
