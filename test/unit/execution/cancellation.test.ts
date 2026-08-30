import { describe, expect, it, vi } from 'vitest';

import { activationId, activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  createExecutionService,
  ExecutionEventType,
  runId,
  RunRepository,
  RunStatus,
  runStream,
} from '../../../src/execution/index.js';
import {
  createEventData,
  EventActorKind,
  EventSourceKind,
  WrongExpectedSequenceError,
  type EventJournal,
} from '../../../src/kernel/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';
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

  it('cancels a starting Run without requiring a runner process', async () => {
    const fixture = executionFixture();
    const id = runId('preparing-run');
    await new RunRepository(fixture.journal).append(id, 0, [
      createEventData({
        eventId: 'preparing-run:preparation',
        eventType: ExecutionEventType.RunPreparationStarted,
        occurredAt: fixture.clock.now().toISOString(),
        correlationId: 'preparing-run',
        causationId: 'preparing-run',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: runStream(id),
        payload: {
          activationId: activationId('preparing-activation'),
          activity: activityName('long-running'),
          workflowInstanceId: workflowInstanceId('workflow-1'),
          orchestrationGroupId: orchestrationGroupId('group-1'),
          attempt: 1,
          startedAt: fixture.clock.now().toISOString(),
        },
      }),
    ]);

    await expect(
      fixture.service.cancelActive(['workflow-1'], 'work-cancelled'),
    ).resolves.toMatchObject([
      { runId: id, status: RunStatus.Cancelled, cancellation: { reason: 'work-cancelled' } },
    ]);
  });

  it('rejects a cancellation request conflict that makes no sequence progress', async () => {
    const clock = new FakeClock();
    const base = new InMemoryEventJournal(clock);
    const journal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        if (events.some((event) => event.eventType === ExecutionEventType.RunCancellationRequested))
          throw new WrongExpectedSequenceError('unchanged sequence');
        return base.appendToStream(stream, expectedSequence, events);
      },
      readStream: base.readStream.bind(base),
      readAll: base.readAll.bind(base),
      latestGlobalPosition: base.latestGlobalPosition.bind(base),
      waitForEventsAfter: base.waitForEventsAfter.bind(base),
      readLatest: base.readLatest?.bind(base),
      changeSignal: base.changeSignal,
    };
    const service = createExecutionService(
      journal,
      new ActivityRegistry(),
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock, ids: new SequentialIds() },
    );
    const id = runId('no-cancellation-progress');
    await new RunRepository(base).append(id, 0, [
      createEventData({
        eventId: `${id}:preparation`,
        eventType: ExecutionEventType.RunPreparationStarted,
        occurredAt: clock.now().toISOString(),
        correlationId: 'group-1',
        causationId: 'activation-1',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: runStream(id),
        payload: {
          activationId: activationId('activation-1'),
          activity: activityName('long-running'),
          workflowInstanceId: workflowInstanceId('workflow-1'),
          orchestrationGroupId: orchestrationGroupId('group-1'),
          attempt: 1,
          startedAt: clock.now().toISOString(),
        },
      }),
    ]);

    await expect(service.requestCancellation(id, 'operator')).rejects.toThrow(
      'did not advance after a cancellation request conflict',
    );
  }, 100);
});
