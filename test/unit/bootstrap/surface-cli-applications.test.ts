import { InProcessJournalChangeSignal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import {
  createOneShotRunnerAdvance,
  createResidentRunnerAdvance,
} from '../../../src/bootstrap/runner-tick-adapter.js';
import {
  createProjectionRebuildApplication,
  createRunnerIdleWait,
  createSelfUpdateQuiescePort,
  createSurfaceCliApplications,
  runResidentLifecycle,
} from '../../../src/bootstrap/surface-cli-applications.js';
import { createRunnerPipeline, ResidentHost, TickHost } from '../../../src/control-plane/index.js';
import { RunStatus } from '../../../src/execution/index.js';

const testProcessorRuntime = {
  processors: [],
  catchUp: async () => 0,
};

function schedulerProcessor<T extends { readonly poke: (...args: never[]) => unknown }>(
  scheduler: T,
) {
  return { ...scheduler, processor: {} as never, lastResult: () => undefined };
}

it('quiesces active runs before rebuilding projections and releases its maintenance lease', async () => {
  const trace: string[] = [];
  let activeRunChecks = 0;
  const application = createProjectionRebuildApplication({
    maintenance: {
      runExclusive: async (tag, recovery, operation) => {
        trace.push(
          `acquire-and-pause:${tag}:${recovery.retrySameTagFailure}:${recovery.replaceDifferentTagFailure}`,
        );
        return operation({ attemptId: 'rebuild-attempt', tag: 'projection-rebuild' });
      },
      clear: async (attemptId) => {
        trace.push(`clear:${attemptId}`);
      },
    },
    activeRunIds: async () => (++activeRunChecks === 1 ? ['run-1'] : []),
    sleep: async () => {
      trace.push('drain');
    },
    rebuild: async () => {
      trace.push('rebuild');
    },
  });

  await application.rebuild();

  expect(trace).toEqual([
    'acquire-and-pause:projection-rebuild:true:false',
    'drain',
    'rebuild',
    'clear:rebuild-attempt',
  ]);
});

it('releases its maintenance lease when projection rebuild fails', async () => {
  const failure = new Error('projection rebuild failed');
  const clear = vi.fn(async () => undefined);
  const application = createProjectionRebuildApplication({
    maintenance: {
      runExclusive: async (_tag, _retryFailed, operation) =>
        operation({ attemptId: 'rebuild-attempt', tag: 'projection-rebuild' }),
      clear,
    },
    activeRunIds: async () => [],
    sleep: async () => undefined,
    rebuild: async () => Promise.reject(failure),
  });

  await expect(application.rebuild()).rejects.toBe(failure);

  expect(clear).toHaveBeenCalledExactlyOnceWith('rebuild-attempt');
});

it('leaves a foreign maintenance lease in place and blocks projection rebuild', async () => {
  const clear = vi.fn(async () => undefined);
  const activeRunIds = vi.fn(async () => []);
  const rebuild = vi.fn(async () => undefined);
  const application = createProjectionRebuildApplication({
    maintenance: {
      runExclusive: async (_tag, _retryFailed, operation) =>
        operation({ attemptId: 'update-attempt', tag: 'self-update' }),
      clear,
    },
    activeRunIds,
    sleep: async () => undefined,
    rebuild,
  });

  await expect(application.rebuild()).rejects.toThrow('self-update');

  expect(activeRunIds).not.toHaveBeenCalled();
  expect(rebuild).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

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
      activationSchedulerSubscriber: schedulerProcessor(scheduler),
      processorRuntime: testProcessorRuntime,
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
    maintain: async () => {
      trace.push('react');
    },
    deliver: async () => {
      trace.push('deliver');
      throw new Error('delivery rejected');
    },
  });

  await expect(
    createOneShotRunnerAdvance({
      activationSchedulerSubscriber: schedulerProcessor(scheduler),
      processorRuntime: testProcessorRuntime,
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

it('runs one-shot scheduling after each fact barrier instead of reusing a cached processor result', async () => {
  const scheduler = {
    poke: vi
      .fn()
      .mockResolvedValueOnce({ kind: 'progressed' as const, dispatched: [] })
      .mockResolvedValueOnce({ kind: 'no-work' as const }),
  };
  const advance = createOneShotRunnerAdvance({
    activationSchedulerSubscriber: {
      ...scheduler,
      processor: {} as never,
      lastResult: () => undefined,
    },
    processorRuntime: testProcessorRuntime,
    runnerPipeline: {
      run: async (_options, _signal, beforeDelivery: (() => Promise<void>) | undefined) => {
        await beforeDelivery?.();
        return { kind: 'no-work' as const };
      },
    },
  });

  await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({ kind: 'progressed' });
  await expect(advance({ maxProgress: 1 })).resolves.toMatchObject({ kind: 'no-work' });
  expect(scheduler.poke).toHaveBeenCalledTimes(2);
});

it('uses the processor-owned scheduler result without a second budgeted scheduler pass', async () => {
  const processorResult = {
    kind: 'progressed' as const,
    dispatched: [{ activationId: 'activation-one', runId: 'run-one' }],
  };
  const scheduler = {
    poke: vi.fn(async () => processorResult),
    lastResult: () => processorResult,
  };
  const advance = createOneShotRunnerAdvance({
    activationSchedulerSubscriber: { ...scheduler, processor: {} as never },
    processorRuntime: {
      processors: [],
      catchUp: vi.fn(async (name: string) => (name === 'activation scheduling' ? 1 : 0)),
    },
    runnerPipeline: {
      run: async (_options, _signal, beforeDelivery: (() => Promise<void>) | undefined) => {
        await beforeDelivery?.();
        return { kind: 'no-work' as const };
      },
    },
  });

  await expect(advance({ maxProgress: 3 })).resolves.toEqual(processorResult);
  expect(scheduler.poke).not.toHaveBeenCalled();
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
    activationSchedulerSubscriber: schedulerProcessor(scheduler),
    processorRuntime: {
      processors: [],
      catchUp: vi.fn(async () => {
        trace.push('facts');
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

  expect(trace).toEqual(['facts', 'pipeline', 'facts', 'facts', 'schedule', 'delivery', 'facts']);
});

it('catches projections again while unwinding an initial projection barrier failure', async () => {
  const processorRuntime = {
    processors: [],
    catchUp: vi.fn().mockRejectedValueOnce(new Error('fact catch-up unavailable')),
  };
  const runnerPipeline = { run: vi.fn(async () => ({ kind: 'no-work' as const })) };

  await expect(
    createOneShotRunnerAdvance({
      activationSchedulerSubscriber: schedulerProcessor({
        poke: async () => ({ kind: 'no-work' as const }),
      }),
      processorRuntime,
      runnerPipeline,
    })({ maxProgress: 1 }),
  ).rejects.toThrow('fact catch-up unavailable');

  expect(processorRuntime.catchUp).toHaveBeenCalledTimes(2);
  expect(runnerPipeline.run).not.toHaveBeenCalled();
});

it('preserves an operational failure when the final one-shot projection barrier also fails', async () => {
  const operationalFailure = new Error('delivery rejected');
  const finalBarrierFailure = new Error('final projection catch-up failed');
  const processorRuntime = {
    processors: [],
    catchUp: vi.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(finalBarrierFailure),
  };

  const result = createOneShotRunnerAdvance({
    activationSchedulerSubscriber: schedulerProcessor({
      poke: async () => ({ kind: 'no-work' as const }),
    }),
    processorRuntime,
    runnerPipeline: { run: async () => Promise.reject(operationalFailure) },
  })({ maxProgress: 1 }).catch((error: unknown) => error);

  await expect(result).resolves.toBeInstanceOf(AggregateError);
  expect(((await result) as AggregateError).errors).toEqual([
    operationalFailure,
    finalBarrierFailure,
  ]);
});

it('preserves an intake failure when the CLI tick final projection barrier also fails', async () => {
  const intakeFailure = new Error('intake failed');
  const finalBarrierFailure = new Error('final projection catch-up failed');
  const projectionSubscriptions = {
    catchUpOnce: vi.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(finalBarrierFailure),
  };
  const applications = createSurfaceCliApplications(
    {
      config: {
        controlPlane: undefined,
        surfaces: { api: { enabled: false } },
        host: {
          development: { mode: 'installed' },
          sandbox: {
            image: 'wake:test',
            containerName: 'wake-test',
            wakeMountPath: '/wake',
            containerHomeMountPath: '/home/wake',
            extraMounts: [],
            start: { enabled: false },
          },
        },
      },
      paths: { wakeRoot: 'C:/wake-test' },
      projectionSubscriptions,
      intakePipeline: { run: async () => Promise.reject(intakeFailure) },
      activationSchedulerSubscriber: { poke: async () => ({ kind: 'no-work' as const }) },
      processorRuntime: testProcessorRuntime,
      runnerPipeline: { run: async () => ({ kind: 'no-work' as const }) },
    } as never,
    {} as never,
    () => '2026-08-29T00:00:00.000Z',
  );

  const result = applications.tick
    .run({ maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 })
    .catch((error: unknown) => error);

  await expect(result).resolves.toBeInstanceOf(AggregateError);
  expect(((await result) as AggregateError).errors).toEqual([intakeFailure, finalBarrierFailure]);
});

it('includes a live starting Run in production self-update quiescence', async () => {
  const isLocallyActive = vi.fn(() => true);
  const recoverActive = vi.fn(async () => []);
  const quiesce = createSelfUpdateQuiescePort({
    recovery: { recoverActive },
    execution: {
      isLocallyActive,
      list: async () => [
        {
          runId: 'run-preparing',
          status: RunStatus.Starting,
          cancellation: undefined,
          lease: { owner: 'execution', expiresAt: '2026-08-30T12:01:00.000Z' },
        },
      ],
    },
  } as never);

  await expect(quiesce.activeRuns()).resolves.toEqual([
    { runId: 'run-preparing', maintenanceCancellable: true },
  ]);
  expect(recoverActive).toHaveBeenCalledWith('self-update', isLocallyActive);
});

it('returns a paused one-shot pipeline result without poking the subscriber', async () => {
  const scheduler = { poke: vi.fn(async () => ({ kind: 'no-work' as const })) };
  const runnerPipeline = {
    run: vi.fn(async () => ({ kind: 'paused' as const })),
  };

  await expect(
    createOneShotRunnerAdvance({
      activationSchedulerSubscriber: schedulerProcessor(scheduler),
      processorRuntime: testProcessorRuntime,
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
        activationSchedulerSubscriber: schedulerProcessor(scheduler),
        processorRuntime: testProcessorRuntime,
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

it('aborts an in-flight resident delivery when the lifecycle stops', async () => {
  const controller = new AbortController();
  let deliveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  const runnerPipeline = createRunnerPipeline({
    runSchedules: async () => undefined,
    maintain: async () => undefined,
    deliver: async (signal) => {
      deliveryStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  const runnerResident = new ResidentHost(
    new TickHost(
      createResidentRunnerAdvance({
        activationSchedulerSubscriber: schedulerProcessor({
          poke: async () => ({ kind: 'no-work' as const }),
        }),
        processorRuntime: testProcessorRuntime,
        runnerPipeline,
      }),
    ),
    async () => undefined,
  );
  const subscriptionRun = () => {
    let resolve!: () => void;
    return {
      abort: () => resolve(),
      done: new Promise<void>((next) => {
        resolve = next;
      }),
    };
  };
  const projections = subscriptionRun();
  const scheduler = subscriptionRun();

  const lifecycle = runResidentLifecycle({
    signal: controller.signal,
    budget: { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 },
    processorRuntime: { start: () => projections },
    activationSchedulerSubscriber: { start: () => scheduler },
    intakeResident: {
      run: async (signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { advances: 0, runs: 0, stoppedBecause: 'shutdown' };
      },
    },
    runnerResident,
    close: async () => undefined,
  });

  await started;
  controller.abort();

  await expect(lifecycle).resolves.toMatchObject({ stoppedBecause: 'shutdown' });
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
    processorRuntime: {
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

it('settles every owned run and preserves resident and subscription failures before closing', async () => {
  const trace: string[] = [];
  const runnerFailure = new Error('runner failed');
  const projectionFailure = new Error('projection subscription failed');
  const subscriptionRun = (name: string, failure?: Error) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((next, fail) => {
      resolve = next;
      reject = fail;
    }).then(
      () => {
        trace.push(`${name}:done`);
      },
      (error: unknown) => {
        trace.push(`${name}:done`);
        throw error;
      },
    );
    return {
      abort: vi.fn(() => {
        trace.push(`${name}:abort`);
        if (failure === undefined) resolve();
        else reject(failure);
      }),
      done,
    };
  };
  const projections = subscriptionRun('projections', projectionFailure);
  const scheduler = subscriptionRun('scheduler');
  const close = vi.fn(async () => {
    trace.push('close');
  });

  const result = runResidentLifecycle({
    signal: new AbortController().signal,
    budget: { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 },
    processorRuntime: { start: () => projections },
    activationSchedulerSubscriber: { start: () => scheduler },
    intakeResident: {
      run: async (signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        trace.push('intake:done');
        return { advances: 0, runs: 0, stoppedBecause: 'shutdown' };
      },
    },
    runnerResident: {
      run: async () => {
        throw runnerFailure;
      },
    },
    close,
  }).catch((error: unknown) => error);

  await expect(result).resolves.toBeInstanceOf(AggregateError);
  const error = await result;
  expect((error as AggregateError).errors).toEqual([runnerFailure, projectionFailure]);
  expect(trace).toContain('intake:done');
  expect(trace).toContain('scheduler:done');
  expect(trace.indexOf('close')).toBeGreaterThan(trace.indexOf('intake:done'));
  expect(trace.indexOf('close')).toBeGreaterThan(trace.indexOf('scheduler:done'));
  expect(close).toHaveBeenCalledOnce();
});

it('continues cleanup when an owned subscription abort throws', async () => {
  const parent = new AbortController();
  const removeListener = vi.spyOn(parent.signal, 'removeEventListener');
  const trace: string[] = [];
  const runnerFailure = new Error('runner failed');
  const abortFailure = new Error('projection abort failed');
  const subscriptionRun = (name: string, abortFails = false) => {
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
        if (abortFails) throw abortFailure;
      }),
      done,
    };
  };
  const projections = subscriptionRun('projections', true);
  const scheduler = subscriptionRun('scheduler');
  const close = vi.fn(async () => {
    trace.push('close');
  });

  const result = runResidentLifecycle({
    signal: parent.signal,
    budget: { maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 },
    processorRuntime: { start: () => projections },
    activationSchedulerSubscriber: { start: () => scheduler },
    intakeResident: {
      run: async (signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        trace.push('intake:done');
        return { advances: 0, runs: 0, stoppedBecause: 'shutdown' };
      },
    },
    runnerResident: {
      run: async () => {
        throw runnerFailure;
      },
    },
    close,
  }).catch((error: unknown) => error);

  await expect(result).resolves.toBeInstanceOf(AggregateError);
  expect(((await result) as AggregateError).errors).toEqual([runnerFailure, abortFailure]);
  expect(scheduler.abort).toHaveBeenCalledOnce();
  expect(trace).toContain('projections:done');
  expect(trace).toContain('scheduler:done');
  expect(trace).toContain('intake:done');
  expect(trace.indexOf('close')).toBeGreaterThan(trace.indexOf('projections:done'));
  expect(trace.indexOf('close')).toBeGreaterThan(trace.indexOf('scheduler:done'));
  expect(trace.indexOf('close')).toBeGreaterThan(trace.indexOf('intake:done'));
  expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(close).toHaveBeenCalledOnce();
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
