import { createEventData } from '@atolis-hq/eventing';
import { expect, it, vi } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import { RunRepository } from '../../../src/execution/application/run-repository.js';
import { ExecutionEventType, runId, runStream } from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

async function seedRun(journal: InMemoryEventJournal, id: string, activation: string) {
  const stream = runStream(runId(id));
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: id,
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {
        activationId: activationId(activation),
        activity: activityName('implement'),
        workflowInstanceId: workflowInstanceId('workflow-1'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        attempt: 1,
        startedAt: '2026-07-30T12:00:00Z',
      },
    }),
  ]);
}

it('reuses the derived run list across repeat calls when no new events landed', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new RunRepository(journal);
  await seedRun(journal, 'run-1', 'activation-1');
  await seedRun(journal, 'run-2', 'activation-2');
  const readAllSpy = vi.spyOn(journal, 'readAll');

  await repository.list();
  readAllSpy.mockClear();
  const second = await repository.list();
  const third = await repository.list();

  expect(readAllSpy).not.toHaveBeenCalled();
  expect(second).toStrictEqual(third);
  expect(second).toHaveLength(2);
});

it('filters the cached list by activationId without re-deriving it', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new RunRepository(journal);
  await seedRun(journal, 'run-1', 'activation-1');
  await seedRun(journal, 'run-2', 'activation-2');

  const filtered = await repository.list(activationId('activation-2'));

  expect(filtered).toHaveLength(1);
  expect(filtered[0]?.activationId).toBe('activation-2');
});
