import { expect, it } from 'vitest';
import { runProjectionPump } from '../../../src/bootstrap/surface-cli-applications.js';

it('advances the resident projection pump while the shared maintenance pause is active', async () => {
  const controller = new AbortController();
  let projectionRuns = 0;

  await runProjectionPump(
    {
      isPaused: async () => {
        controller.abort();
        return true;
      },
      projectionRunner: {
        runRegisteredOnce: async () => {
          projectionRuns += 1;
          controller.abort();
        },
      },
    } as never,
    controller.signal,
  );

  expect(projectionRuns).toBe(1);
});
