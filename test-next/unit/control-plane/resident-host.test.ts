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

it('starts another tick after an idle backoff', async () => {
  const controller = new AbortController();
  let calls = 0;
  const host = new ResidentHost(
    {
      async run() {
        calls += 1;
        return { advances: 0, runs: 0, stoppedBecause: 'idle' as const };
      },
    },
    async () => {
      if (calls === 2) controller.abort();
    },
  );

  await host.run(controller.signal, budget);
  expect(calls).toBe(2);
});

it('logs a failed tick and continues polling', async () => {
  const controller = new AbortController();
  let calls = 0;
  const errors: unknown[] = [];
  const host = new ResidentHost(
    {
      async run() {
        calls += 1;
        if (calls === 1) throw new Error('workspace cleanup failed');
        controller.abort();
        return { advances: 1, runs: 0, stoppedBecause: 'idle' as const };
      },
    },
    async () => undefined,
    async (error) => {
      errors.push(error);
    },
  );

  await expect(host.run(controller.signal, budget)).resolves.toMatchObject({
    advances: 1,
    runs: 0,
  });
  expect(calls).toBe(2);
  expect(errors).toEqual([expect.objectContaining({ message: 'workspace cleanup failed' })]);
});

it('tracks consecutive errors separately from consecutive idle ticks, resetting errors on any non-throwing cycle', async () => {
  const controller = new AbortController();
  // throw, throw, idle (no progress, no throw), throw, then abort.
  const outcomes: readonly ('throw' | 'idle')[] = ['throw', 'throw', 'idle', 'throw'];
  let calls = 0;
  const cadences: { consecutiveIdleTicks: number; consecutiveErrorTicks: number }[] = [];
  const host = new ResidentHost(
    {
      async run() {
        const outcome = outcomes[calls]!;
        calls += 1;
        if (outcome === 'throw') throw new Error(`failure ${calls}`);
        return { advances: 0, runs: 0, stoppedBecause: 'idle' as const };
      },
    },
    async (_signal, cadence) => {
      cadences.push(cadence);
      if (calls === outcomes.length) controller.abort();
    },
    async () => undefined,
  );

  await host.run(controller.signal, budget);

  expect(cadences).toEqual([
    { consecutiveIdleTicks: 1, consecutiveErrorTicks: 1 },
    { consecutiveIdleTicks: 2, consecutiveErrorTicks: 2 },
    { consecutiveIdleTicks: 3, consecutiveErrorTicks: 0 },
    { consecutiveIdleTicks: 4, consecutiveErrorTicks: 1 },
  ]);
});
