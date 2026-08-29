import { expect, it, vi } from 'vitest';
import {
  createOneShotRunnerAdvance,
  createResidentRunnerAdvance,
} from '../../../src/bootstrap/runner-tick-adapter.js';
import {
  createRunnerIdleWait,
  runResidentLifecycle,
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
      projectionSubscriptions: { catchUpOnce: async () => 0 },
      runnerPipeline,
    }),
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
    runSchedules: async () => {
      trace.push('run-schedules');
    },
    react: async () => {
      trace.push('react');
    },
    deliver: async () => {
      trace.push('deliver');
      throw new Error('delivery rejected');
    },
  });

  await expect(
    createOneShotRunnerAdvance({
      activationSchedulerSubscriber: scheduler,
      projectionSubscriptions: { catchUpOnce: async () => 0 },
      runnerPipeline,
    })({
      maxProgress: 1,
    }),
  ).rejects.toThrow('delivery rejected');

  expect(scheduler.poke).toHaveBeenCalledOnce();
  expect(trace.indexOf('run-schedules')).toBeLessThan(trace.indexOf('schedule'));
  expect(trace.indexOf('react')).toBeLessThan(trace.indexOf('schedule'));
  expect(trace.indexOf('schedule')).toBeLessThan(trace.indexOf('deliver'));
});

it('catches projections before pipeline work, before the scheduler poke, and after failure', async () => {
  const trace: string[] = [];
  const scheduler = {
    poke: vi.fn(async () => {
      trace.push('schedule');
      return { kind: 'no-work' as const };
    }),
  };
  const root = {
    activationSchedulerSubscriber: scheduler,
    projectionSubscriptions: {
      catchUpOnce: vi.fn(async () => {
        trace.push('projections');
        return 0;
      }),
    },
    runnerPipeline: {
      run: vi.fn(async (_options, _signal, beforeDelivery: (() => Promise<void>) | undefined) => {
        trace.push('pipeline');
        await beforeDelivery?.();
        trace.push('delivery');
        throw new Error('delivery rejected');
      }),
    },
  };

  await expect(createOneShotRunnerAdvance(root)({ maxProgress: 1 })).rejects.toThrow(
    'delivery rejected',
  );

  expect(trace).toEqual([
    'projections',
    'pipeline',
    'projections',
    'schedule',
    'delivery',
    'projections',
  ]);
});

it('catches projections again while unwinding an initial projection barrier failure', async () => {
  const projectionSubscriptions = {
    catchUpOnce: vi.fn().mockRejectedValueOnce(new Error('projection unavailable')),
  };
  const runnerPipeline = { run: vi.fn(async () => ({ kind: 'no-work' as const })) };

  await expect(
    createOneShotRunnerAdvance({
      activationSchedulerSubscriber: { poke: async () => ({ kind: 'no-work' as const }) },
      projectionSubscriptions,
      runnerPipeline,
    })({ maxProgress: 1 }),
  ).rejects.toThrow('projection unavailable');

  expect(projectionSubscriptions.catchUpOnce).toHaveBeenCalledTimes(2);
  expect(runnerPipeline.run).not.toHaveBeenCalled();
});

it('returns a paused one-shot pipeline result without poking the subscriber', async () => {
  const scheduler = { poke: vi.fn(async () => ({ kind: 'no-work' as const })) };
  const runnerPipeline = {
    run: vi.fn(async () => ({ kind: 'paused' as const })),
  };

  await expect(
    createOneShotRunnerAdvance({
      activationSchedulerSubscriber: scheduler,
      projectionSubscriptions: { catchUpOnce: async () => 0 },
      runnerPipeline,
    })({
      maxProgress: 1,
    }),
  ).resolves.toEqual({ kind: 'paused' });

  expect(scheduler.poke).not.toHaveBeenCalled();
});

it('does not let a blocking subscriber poke stall subscriber-mode resident runner work', async () => {
  const controller = new AbortController();
  const scheduler = { poke: vi.fn(async () => ({ kind: 'no-work' as const })) };
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
      }),
    ),
  );

  await expect(
    resident.run(controller.signal, { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 }),
  ).resolves.toMatchObject({ stoppedBecause: 'shutdown' });

  expect(runnerPipeline.run).toHaveBeenCalledOnce();
  expect(scheduler.poke).not.toHaveBeenCalled();
});

it('supervises projection subscriptions before residents and aborts every owned run before awaiting', async () => {
  const controller = new AbortController();
  const trace: string[] = [];
  const subscriptionRun = (name: string) => {
    let resolve!: () => void;
    const done = new Promise<void>((next) => {
      resolve = next;
    }).then(() => {
      trace.push(`${name}:done`);
    });
    return {
      abort: vi.fn(() => {
        trace.push(`${name}:abort`);
        resolve();
      }),
      done,
    };
  };
  const projections = subscriptionRun('projections');
  const scheduler = subscriptionRun('scheduler');
  let intakeSettled = false;
  await runResidentLifecycle({
    signal: controller.signal,
    budget: { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 },
    projectionSubscriptions: {
      start: vi.fn(() => {
        trace.push('projections:start');
        return projections;
      }),
    },
    activationSchedulerSubscriber: {
      start: vi.fn(() => {
        trace.push('scheduler:start');
        return scheduler;
      }),
    },
    intakeResident: {
      run: async (signal: AbortSignal) => {
        trace.push('intake:start');
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        intakeSettled = true;
        return { advances: 0, runs: 0, stoppedBecause: 'shutdown' };
      },
    },
    runnerResident: {
      run: async () => {
        trace.push('runner');
        controller.abort();
        return { advances: 0, runs: 0, stoppedBecause: 'shutdown' };
      },
    },
    close: async () => undefined,
  });

  expect(trace.slice(0, 4)).toEqual([
    'projections:start',
    'scheduler:start',
    'intake:start',
    'runner',
  ]);
  expect(projections.abort).toHaveBeenCalledOnce();
  expect(scheduler.abort).toHaveBeenCalledOnce();
  expect(intakeSettled).toBe(true);
  expect(trace.indexOf('projections:abort')).toBeLessThan(trace.indexOf('projections:done'));
  expect(trace.indexOf('scheduler:abort')).toBeLessThan(trace.indexOf('scheduler:done'));
  expect(trace.indexOf('scheduler:abort')).toBeLessThan(trace.indexOf('projections:done'));
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
