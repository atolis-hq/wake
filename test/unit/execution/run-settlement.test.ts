import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { afterEach, expect, it, vi } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import {
  createExecutionEventData,
  ExecutionEventType,
  runId,
  runStream,
} from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { createRunSettlement } from '../../support/run-settlement.js';

const instant = '2026-11-19T12:00:00Z';
const metadata = {
  occurredAt: instant,
  correlationId: 'settlement',
  causationId: 'settlement',
  actor: { kind: 'system' as const, id: 'test' },
  source: { kind: 'internal' as const, id: 'test' },
};
const journalForTest = () => new InMemoryEventJournal({ now: () => new Date(instant) });

async function start(journal: InMemoryEventJournal, id: string) {
  await journal.appendToStream(runStream(runId(id)), 0, [
    createExecutionEventData({
      ...metadata,
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      payload: {
        activationId: activationId(id),
        activity: activityName('implement'),
        workflowInstanceId: workflowInstanceId(id),
        orchestrationGroupId: orchestrationGroupId('group'),
        attempt: 1,
        startedAt: instant,
      },
    }),
  ]);
}

async function finish(journal: InMemoryEventJournal, id: string) {
  await journal.appendToStream(runStream(runId(id)), 1, [
    createExecutionEventData({
      ...metadata,
      eventId: `${id}:finished`,
      eventType: ExecutionEventType.RunCancelled,
      payload: { finishedAt: instant },
    }),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('waits for the selected Run fact regardless of elapsed polling time or other workflows', async () => {
  vi.useFakeTimers();
  const journal = journalForTest();
  await start(journal, 'selected');
  await start(journal, 'other');
  let settled = false;
  const waiting = createRunSettlement(journal)({ runId: 'selected' }).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(settled).toBe(false);
  await finish(journal, 'selected');
  await waiting;
  expect(settled).toBe(true);
});

it('does not miss a completion committed between reading status and subscribing', async () => {
  const journal = journalForTest();
  await start(journal, 'selected');
  const wait = journal.waitForEventsAfter.bind(journal);
  vi.spyOn(journal, 'waitForEventsAfter').mockImplementationOnce(async (...args) => {
    await finish(journal, 'selected');
    await wait(...args);
  });
  await createRunSettlement(journal)({ runId: 'selected' });
  expect(journal.waitForEventsAfter).toHaveBeenCalledOnce();
});

it('does not treat an unregistered expected Run as already complete', async () => {
  vi.useFakeTimers();
  const journal = journalForTest();
  let settled = false;
  const waiting = createRunSettlement(journal)({ runId: 'expected' }).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(settled).toBe(false);
  await start(journal, 'expected');
  await finish(journal, 'expected');
  await waiting;
  expect(settled).toBe(true);
});
