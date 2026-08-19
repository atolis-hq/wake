import { expect, it } from 'vitest';
import { runProjectionPump } from '../../../src/bootstrap/surface-cli-applications.js';
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
      config: { controlPlane: {} },
    } as never,
    controller.signal,
  );

  expect(projectionRuns).toBe(1);
});
