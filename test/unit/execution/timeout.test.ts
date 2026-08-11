import { expect, it } from 'vitest';

import { executionFixture } from './support.js';

it('turns timeout into a durable cancellation reason', async () => {
  const fixture = executionFixture();
  const pending = fixture.start();
  const run = await fixture.started();

  await expect(fixture.service.requestCancellation(run.runId, 'timeout')).resolves.toMatchObject({
    cancellation: { reason: 'timeout', requestedAt: '2026-07-30T12:00:00.000Z' },
  });

  fixture.complete({ kind: 'done' });
  await pending;
});
