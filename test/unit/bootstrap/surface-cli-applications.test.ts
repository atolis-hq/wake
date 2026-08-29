import { expect, it, vi } from 'vitest';
import {
  createOneShotRunnerAdvance,
  createResidentRunnerAdvance,
} from '../../../src/bootstrap/runner-tick-adapter.js';
import {
  createRunnerIdleWait,
  runProjectionPump,
} from '../../../src/bootstrap/surface-cli-applications.js';
import { createRunnerPipeline, ResidentHost, TickHost } from '../../../src/control-plane/index.js';
import { InProcessJournalChangeSignal } from '../../../src/kernel/index.js';

it('drains subscriber scheduling progress through a one-shot tick budget while running the pipeline', async () => {
  const scheduler = {
    poke: vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'progressed',
        dispatched: [{ activationId: 'activation-one', runId: 'run-one' }],
      })
      .mockResolvedValueOnce({
        kind: 'progressed',
        dispatched: [{ activationId: 'activation-two', runId: 'run-two' }],
      })
      .mockResolvedValueOnce({ kind: 'no-work' }),
  };
  const runnerPipeline = {
    run: vi.fn(async (_options, _signal, beforeDelivery: (() => Promise<void>) | undefined) => {
      await beforeDelivery?.();
      return { kind: 'no-work' as const };
    }),
  };
  const tick = new TickHost(
    createOneShotRunnerAdvance({
      activationSchedulerSubscriber: scheduler,
      runnerPipeline,
    } as never),
  );

  await expect(tick.run({ maxAdvances: 3, maxRuns: 3, maxDurationMs: 1_000 })).resolves.toEqual({
    advances: 2,
    runs: 2,
    stoppedBecause: 'idle',
  });

  expect(scheduler.poke).toHaveBeenCalledTimes(3);
  expect(runnerPipeline.run).toHaveBeenCalledTimes(3);
});

it('pokes subscriber scheduling after schedule/reactor facts and before a failing delivery', async () => {
  const trace: string[] = [];
  const scheduler = {
    poke: vi.fn(async () => {
      trace.push('schedule');
      return {
        kind: 'progressed' as const,
        dispatched: [{ activationId: 'activation-one', runId: 'run-one' }],
      };
    }),
  };
  const runnerPipeline = createRunnerPipeline({
    catchUpProjections: async () => {
      trace.push('projections');
    },
    runSchedules: async () => {
      trace.push('run-schedules');
    },
    react: async () => {
      trace.push('react');
    },
    advance: async () => ({ kind: 'no-work' as const }),
    inlineActivationScheduling: false,
    deliver: async () => {
      trace.push('deliver');
      throw new Error('delivery rejected');
    },
  });

  await expect(
    createOneShotRunnerAdvance({ activationSchedulerSubscriber: scheduler, runnerPipeline })({
      maxProgress: 1,
    }),
  ).rejects.toThrow('delivery rejected');

  expect(scheduler.poke).toHaveBeenCalledOnce();
  expect(trace.indexOf('run-schedules')).toBeLessThan(trace.indexOf('schedule'));
  expect(trace.indexOf('react')).toBeLessThan(trace.indexOf('schedule'));
  expect(trace.indexOf('schedule')).toBeLessThan(trace.indexOf('deliver'));
});

it('does not let a blocking subscriber poke stall subscriber-mode resident runner work', async () => {
  const controller = new AbortController();
  const scheduler = { poke: vi.fn(() => new Promise(() => {})) };
  const runnerPipeline = {
    run: vi.fn(async () => {
      controller.abort();
      return { kind: 'no-work' as const };
    }),
  };
  const resident = new ResidentHost(
    new TickHost(
      createResidentRunnerAdvance({
        activationSchedulerSubscriber: scheduler,
        runnerPipeline,
      } as never),
    ),
  );

  await expect(
    resident.run(controller.signal, { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 }),
  ).resolves.toMatchObject({ stoppedBecause: 'shutdown' });

  expect(runnerPipeline.run).toHaveBeenCalledOnce();
  expect(scheduler.poke).not.toHaveBeenCalled();
});

it('advances the resident projection pump', async () => {
  const controller = new AbortController();
  let projectionRuns = 0;

  await runProjectionPump(
    {
      projectionSubscriptions: {
        catchUpOnce: async () => {
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

it('does not initialize the resident cursor until idle waiting starts', async () => {
  const latestGlobalPosition = vi.fn(async () => 0);
  const waitForEventsAfter = vi.fn(async () => undefined);
  const report = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const wait = createRunnerIdleWait(
      {
        journal: {
          latestGlobalPosition,
          waitForEventsAfter,
          changeSignal: new InProcessJournalChangeSignal(),
        },
      } as never,
      { pollBackoffMs: 0 },
    );

    expect(latestGlobalPosition).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();

    await wait(new AbortController().signal, {
      consecutiveIdleTicks: 0,
      consecutiveErrorTicks: 0,
    });
    expect(latestGlobalPosition).toHaveBeenCalledTimes(1);
  } finally {
    report.mockRestore();
  }
});

it('waits after reported progress that did not change the journal', async () => {
  const controller = new AbortController();
  let waitStarted!: () => void;
  const waitObserved = new Promise<void>((resolve) => {
    waitStarted = resolve;
  });
  const waitForEventsAfter = vi.fn(
    (_position: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        waitStarted();
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
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

  await waitObserved;
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
  let releaseRead!: () => void;
  let readStarted!: () => void;
  const readBarrier = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readObserved = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const waitForEventsAfter = vi.fn(async (after: number) => {
    expect(after).toBe(0);
  });
  const journal = {
    readAll: async () => {
      const snapshot = [{ globalPosition: position }];
      readStarted();
      await readBarrier;
      return snapshot;
    },
    latestGlobalPosition: async () => position,
    waitForEventsAfter,
    changeSignal: new InProcessJournalChangeSignal(),
  };
  const wait = createRunnerIdleWait({ journal } as never, { pollBackoffMs: 30_000 });

  const pass = journal.readAll();
  await readObserved;
  position = 1;
  releaseRead();
  await pass;
  const waiting = wait(controller.signal, { consecutiveIdleTicks: 1, consecutiveErrorTicks: 0 });
  await waiting;
  expect(waitForEventsAfter).toHaveBeenCalledTimes(1);
});

it('keeps the projection pump alive when cursor sampling fails once', async () => {
  const controller = new AbortController();
  let runs = 0;
  const latestGlobalPosition = vi
    .fn<() => Promise<number>>()
    .mockRejectedValueOnce(new Error('cursor unavailable'))
    .mockResolvedValue(0);
  const waitForEventsAfter = vi.fn(async () => undefined);
  await expect(
    runProjectionPump(
      {
        projectionSubscriptions: {
          catchUpOnce: async () => {
            runs += 1;
            controller.abort();
          },
        },
        journal: {
          latestGlobalPosition,
          waitForEventsAfter,
          changeSignal: new InProcessJournalChangeSignal(),
        },
      } as never,
      controller.signal,
    ),
  ).resolves.toBeUndefined();
  expect(runs).toBe(1);
  expect(latestGlobalPosition).toHaveBeenCalledTimes(2);
  expect(waitForEventsAfter).toHaveBeenCalledWith(0, expect.any(AbortSignal), expect.any(Number));
});

it('keeps resident waiting alive when the initial and current cursors fail', async () => {
  const latestGlobalPosition = vi
    .fn<() => Promise<number>>()
    .mockRejectedValueOnce(new Error('initial cursor unavailable'))
    .mockResolvedValueOnce(0)
    .mockRejectedValueOnce(new Error('current cursor unavailable'))
    .mockResolvedValue(0);
  const waitForEventsAfter = vi.fn(async () => undefined);
  const wait = createRunnerIdleWait(
    {
      journal: {
        latestGlobalPosition,
        waitForEventsAfter,
        changeSignal: new InProcessJournalChangeSignal(),
      },
    } as never,
    { pollBackoffMs: 0 },
  );

  await expect(
    wait(new AbortController().signal, { consecutiveIdleTicks: 0, consecutiveErrorTicks: 0 }),
  ).resolves.toBeUndefined();
  await expect(
    wait(new AbortController().signal, { consecutiveIdleTicks: 1, consecutiveErrorTicks: 0 }),
  ).resolves.toBeUndefined();
  await expect(
    wait(new AbortController().signal, { consecutiveIdleTicks: 2, consecutiveErrorTicks: 0 }),
  ).resolves.toBeUndefined();
  expect(waitForEventsAfter).toHaveBeenCalledWith(0, expect.any(AbortSignal), expect.any(Number));
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
  const journal = {
    readAll: async () => {
      const snapshot = [{ globalPosition: position }];
      passStarted();
      await passBarrier;
      return snapshot;
    },
    latestGlobalPosition: async () => position,
    waitForEventsAfter,
    changeSignal: new InProcessJournalChangeSignal(),
  };
  const pump = runProjectionPump(
    {
      projectionSubscriptions: {
        catchUpOnce: async () => {
          await journal.readAll();
        },
      },
      journal,
    } as never,
    controller.signal,
  );
  await passObserved;
  position = 1;
  releasePass();
  await pump;
  expect(waitForEventsAfter).toHaveBeenCalledTimes(1);
});
