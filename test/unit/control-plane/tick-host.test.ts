import { expect, it, vi } from 'vitest';
import {
  TickHost,
  type AdvanceResult,
  type HostBudget,
  type PhasedAdvanceOnce,
} from '../../../src/control-plane/index.js';

const budget: HostBudget = { maxAdvances: 2, maxRuns: 2, maxDurationMs: 1000 };

it('runs one bounded cycle and reports why it stopped', async () => {
  const results: AdvanceResult[] = [
    { kind: 'progressed', dispatched: [{ activationId: 'activation-a', runId: 'run-a' }] },
    { kind: 'no-work' },
  ];
  const host = new TickHost(async () => results.shift() ?? { kind: 'no-work' });

  await expect(host.run(budget)).resolves.toEqual({
    advances: 1,
    runs: 1,
    stoppedBecause: 'idle',
  });
});

it('runs maintenance once before multiple dispatch attempts in one tick', async () => {
  const maintain = vi.fn(async () => ({ kind: 'ready' as const }));
  const dispatch = vi
    .fn<NonNullable<PhasedAdvanceOnce['dispatch']>>()
    .mockResolvedValueOnce({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-a', runId: 'run-a' }],
    })
    .mockResolvedValueOnce({
      kind: 'progressed',
      dispatched: [{ activationId: 'activation-b', runId: 'run-b' }],
    });
  const advance = Object.assign(async (): Promise<AdvanceResult> => ({ kind: 'no-work' }), {
    maintain,
    dispatch,
  }) satisfies PhasedAdvanceOnce;

  await expect(new TickHost(advance).run(budget)).resolves.toEqual({
    advances: 2,
    runs: 2,
    stoppedBecause: 'budget',
  });
  expect(maintain).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(2);
});
