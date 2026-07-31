import { describe, expect, it } from 'vitest';
import { DispatchPolicy } from '../../src-next/control-plane/index.js';

const candidate = (overrides: Partial<Parameters<DispatchPolicy['select']>[0][number]> = {}) => ({
  workItemId: overrides.workItemId ?? 'work-a',
  activationId: overrides.activationId ?? 'activation-a',
  requestedPosition: overrides.requestedPosition ?? 1,
  hasActiveRun: overrides.hasActiveRun ?? false,
  cancelled: overrides.cancelled ?? false,
});

describe('DispatchPolicy', () => {
  it('selects the oldest eligible activation without starving another WorkItem', () => {
    const policy = new DispatchPolicy({ maxDispatches: 2 });

    expect(
      policy.select([
        candidate({ workItemId: 'a', activationId: 'late', requestedPosition: 4 }),
        candidate({ workItemId: 'b', activationId: 'early', requestedPosition: 2 }),
        candidate({ workItemId: 'a', activationId: 'early', requestedPosition: 1 }),
      ]),
    ).toEqual([
      expect.objectContaining({ activationId: 'early', workItemId: 'a' }),
      expect.objectContaining({ activationId: 'early', workItemId: 'b' }),
    ]);
  });

  it('enforces one active Run per WorkItem and a global dispatch limit', () => {
    const policy = new DispatchPolicy({ maxDispatches: 1 });

    expect(
      policy.select([
        candidate({
          workItemId: 'a',
          activationId: 'active',
          requestedPosition: 1,
          hasActiveRun: true,
        }),
        candidate({ workItemId: 'b', activationId: 'ready', requestedPosition: 2 }),
        candidate({ workItemId: 'c', activationId: 'later', requestedPosition: 3 }),
      ]),
    ).toEqual([expect.objectContaining({ workItemId: 'b', activationId: 'ready' })]);
  });

  it('excludes cancelled activations and a globally blocked dispatch', () => {
    const policy = new DispatchPolicy({ maxDispatches: 3 });

    expect(
      policy.select(
        [candidate({ cancelled: true }), candidate({ workItemId: 'b', activationId: 'ready' })],
        { blocked: true },
      ),
    ).toEqual([]);
  });
});
