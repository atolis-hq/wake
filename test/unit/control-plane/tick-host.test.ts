import { expect, it } from 'vitest';
import { TickHost, type AdvanceResult, type HostBudget } from '../../../src/control-plane/index.js';

const budget: HostBudget = { maxAdvances: 2, maxRuns: 2, maxDurationMs: 1000 };

it('runs one bounded cycle and reports why it stopped', async () => {
  const results: AdvanceResult[] = [
    { kind: 'progressed', activationId: 'activation-a', runId: 'run-a' },
    { kind: 'no-work' },
  ];
  const host = new TickHost(async () => results.shift() ?? { kind: 'no-work' });

  await expect(host.run(budget)).resolves.toEqual({
    advances: 1,
    runs: 1,
    stoppedBecause: 'idle',
  });
});
