import { describe, expect, it, vi } from 'vitest';

import { ExecutionEventType, RunStatus } from '../../../src/execution/index.js';
import { executionFixture } from './support.js';

describe('Run cancellation', () => {
  it.each([
    ['idle', 'idle-timeout'],
    ['hard', 'timeout'],
  ] as const)('cancels a Run when the runner reaches its %s deadline', async (kind, reason) => {
    const fixture = executionFixture(kind);
    const pending = fixture.start();

    await expect(fixture.finished(RunStatus.Cancelled)).resolves.toMatchObject({
      status: 'cancelled',
      cancellation: { reason, confirmedAt: '2026-07-30T12:00:00.000Z' },
    });

    fixture.complete({ kind: 'done' });
    await pending;
  });

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
    await expect(fixture.finished(RunStatus.Succeeded)).resolves.toMatchObject({
      status: 'succeeded',
    });
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
    await expect(fixture.finished(RunStatus.Cancelled)).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('signals the active runner again when cancellation was already recorded', async () => {
    const fixture = executionFixture();
    const pending = fixture.start();
    const run = await fixture.started();
    const abort = vi.spyOn(AbortController.prototype, 'abort');

    await fixture.service.requestCancellation(run.runId, 'operator');
    abort.mockClear();
    await fixture.service.requestCancellation(run.runId, 'operator');

    expect(abort).toHaveBeenCalledWith('operator');
    fixture.complete({ kind: 'done' });
    await pending;
  });
});
