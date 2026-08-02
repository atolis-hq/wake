import { describe, expect, it } from 'vitest';

import { ExecutionEventType } from '../../../src-next/execution/index.js';
import { executionFixture } from './support.js';

describe('Run cancellation', () => {
  it('records cancellation request before signalling the runner', async () => {
    const fixture = executionFixture();
    const pending = fixture.start();
    const run = await fixture.started();

    await fixture.service.requestCancellation(run.runId, 'operator');

    expect((await fixture.events()).map((event) => event.eventType)).toContain(
      ExecutionEventType.RunCancellationRequested,
    );
    expect(fixture.cancelled).toBe(true);
    fixture.complete({ kind: 'done' });
    await pending;
    await expect(fixture.service.list()).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
  });

  it('records cancellation confirmation separately', async () => {
    const fixture = executionFixture();
    const pending = fixture.start();
    const run = await fixture.started();
    await fixture.service.requestCancellation(run.runId, 'work-cancelled');

    await expect(fixture.service.confirmCancellation(run.runId)).resolves.toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'work-cancelled', confirmedAt: '2026-07-30T12:00:00.000Z' },
    });

    fixture.complete({ kind: 'done' });
    await pending;
    await expect(fixture.service.list()).resolves.toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });
});
