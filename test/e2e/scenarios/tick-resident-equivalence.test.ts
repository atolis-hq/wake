import { expect, it } from 'vitest';
import { composeControlPlaneHosts } from '../../../src/bootstrap/index.js';

const scenario = { id: 'E2E-CONTROL-002' } as const;

it(`${scenario.id}: TickHost and ResidentHost share bounded advancement`, async () => {
  const calls: number[] = [];
  const controller = new AbortController();
  const runtime = composeControlPlaneHosts(async () => {
    calls.push(calls.length);
    if (calls.length === 2) controller.abort();
    return { kind: 'no-work' as const };
  });
  const budget = { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1000 };
  await expect(runtime.tick.run(budget)).resolves.toMatchObject({ stoppedBecause: 'idle' });
  await expect(runtime.resident.run(controller.signal, budget)).resolves.toMatchObject({
    stoppedBecause: 'shutdown',
  });
  expect(calls).toHaveLength(2);
});
