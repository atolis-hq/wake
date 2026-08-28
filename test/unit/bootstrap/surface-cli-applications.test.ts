import { expect, it } from 'vitest';
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
      journal: { changeSignal: new InProcessJournalChangeSignal() },
    } as never,
    controller.signal,
  );

  expect(projectionRuns).toBe(1);
});

it('waits after reported progress that did not change the journal', async () => {
  const controller = new AbortController();
  const changeSignal = new InProcessJournalChangeSignal();
  const wait = createRunnerIdleWait({ journal: { changeSignal } } as never, {
    pollBackoffMs: 1_000,
  });
  let settled = false;
  const sleeping = wait(controller.signal, {
    consecutiveIdleTicks: 0,
    consecutiveErrorTicks: 0,
  }).then(() => {
    settled = true;
  });

  await Promise.resolve();

  expect(settled).toBe(false);
  controller.abort();
  await sleeping;
});

it('immediately drains after progress that appended a journal fact', async () => {
  const controller = new AbortController();
  const changeSignal = new InProcessJournalChangeSignal();
  const wait = createRunnerIdleWait({ journal: { changeSignal } } as never, {
    pollBackoffMs: 1_000,
  });
  changeSignal.notify();

  await wait(controller.signal, { consecutiveIdleTicks: 0, consecutiveErrorTicks: 0 });
});
