import { expect, it } from 'vitest';
import { ResidentHost, type HostBudget } from '../../../src-next/control-plane/index.js';

const budget: HostBudget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1000 };

it('reuses TickHost advancement and stops on an abort signal', async () => {
  const controller = new AbortController();
  let calls = 0;
  const host = new ResidentHost(
    {
      async run() {
        calls += 1;
        controller.abort();
        return { advances: 1, runs: 1, stoppedBecause: 'budget' as const };
      },
    },
    async () => undefined,
  );

  await expect(host.run(controller.signal, budget)).resolves.toMatchObject({
    advances: 1,
    runs: 1,
    stoppedBecause: 'shutdown',
  });
  expect(calls).toBe(1);
});
