import { expect, it, vi } from 'vitest';
import {
  createRunnerIdleWait,
  runProjectionPump,
} from '../../../src/bootstrap/surface-cli-applications.js';
import { InProcessJournalChangeSignal } from '../../../src/kernel/index.js';

it('advances the resident projection pump', async () => {
  const controller = new AbortController();
  let projectionRuns = 0;

  await runProjectionPump(
    {
      projectionRunner: {
        runRegisteredOnce: async () => {
          projectionRuns += 1;
          controller.abort();
        },
      },
      journal: {
        latestGlobalPosition: async () => 0,
        waitForEventsAfter: async () => undefined,
        changeSignal: new InProcessJournalChangeSignal(),
      },
    } as never,
    controller.signal,
  );

  expect(projectionRuns).toBe(1);
});

it('waits after reported progress that did not change the journal', async () => {
  const controller = new AbortController();
  const waitForEventsAfter = vi.fn(
    (_position: number, signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
  );
  const wait = createRunnerIdleWait(
    {
      journal: {
        latestGlobalPosition: async () => 0,
        waitForEventsAfter,
        changeSignal: new InProcessJournalChangeSignal(),
      },
    } as never,
    {
      pollBackoffMs: 1_000,
    },
  );
  let settled = false;
  const sleeping = wait(controller.signal, {
    consecutiveIdleTicks: 0,
    consecutiveErrorTicks: 0,
  }).then(() => {
    settled = true;
  });

  await Promise.resolve();
  await Promise.resolve();

  expect(settled).toBe(false);
  expect(waitForEventsAfter).toHaveBeenCalledWith(0, expect.any(AbortSignal), expect.any(Number));
  controller.abort();
  await sleeping;
  expect(settled).toBe(true);
});

it('immediately drains after progress that appended a journal fact', async () => {
  const controller = new AbortController();
  let position = 0;
  const waitForEventsAfter = vi.fn(async () => undefined);
  const wait = createRunnerIdleWait(
    {
      journal: {
        latestGlobalPosition: async () => position,
        waitForEventsAfter,
        changeSignal: new InProcessJournalChangeSignal(),
      },
    } as never,
    {
      pollBackoffMs: 1_000,
    },
  );
  position = 1;

  await wait(controller.signal, { consecutiveIdleTicks: 0, consecutiveErrorTicks: 0 });
  expect(controller.signal.aborted).toBe(false);
  expect(waitForEventsAfter).toHaveBeenCalledWith(0, expect.any(AbortSignal), expect.any(Number));
});

it('uses the durable wait when an append lands between runner pass and idle wait', async () => {
  const controller = new AbortController();
  let position = 0;
  let allowWait!: () => void;
  const waitStarted = new Promise<void>((resolve) => {
    allowWait = resolve;
  });
  const waitForEventsAfter = vi.fn(async (after: number) => {
    expect(after).toBe(0);
    allowWait();
  });
  const wait = createRunnerIdleWait(
    {
      journal: {
        latestGlobalPosition: async () => position,
        waitForEventsAfter,
        changeSignal: new InProcessJournalChangeSignal(),
      },
    } as never,
    { pollBackoffMs: 30_000 },
  );

  position = 1;
  const waiting = wait(controller.signal, { consecutiveIdleTicks: 1, consecutiveErrorTicks: 0 });
  await waitStarted;
  await waiting;
  expect(waitForEventsAfter).toHaveBeenCalledTimes(1);
});

it('waits after the pass cursor when an append lands during projection', async () => {
  const controller = new AbortController();
  let position = 0;
  let releasePass!: () => void;
  let passStarted!: () => void;
  const passBarrier = new Promise<void>((resolve) => {
    releasePass = resolve;
  });
  const passObserved = new Promise<void>((resolve) => {
    passStarted = resolve;
  });
  const waitForEventsAfter = vi.fn(async (after: number) => {
    expect(after).toBe(0);
    controller.abort();
  });
  const pump = runProjectionPump(
    {
      projectionRunner: {
        runRegisteredOnce: async () => {
          passStarted();
          await passBarrier;
        },
      },
      journal: {
        latestGlobalPosition: async () => position,
        waitForEventsAfter,
        changeSignal: new InProcessJournalChangeSignal(),
      },
    } as never,
    controller.signal,
  );
  await passObserved;
  position = 1;
  releasePass();
  await pump;
  expect(waitForEventsAfter).toHaveBeenCalledTimes(1);
});
