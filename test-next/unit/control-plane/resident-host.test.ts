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
