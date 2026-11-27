import { correlationId, createEventData, registerViewSnapshotStore } from '@atolis-hq/eventing';
import { InMemoryEventJournal, InMemoryViewSnapshotStore } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { DelegationGate } from '../../../src/orchestration/application/delegation-gate.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { WorkIndex } from '../../../src/work/application/work-index.js';
import { createWorkService, workItemStream } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = (seed: string) => ({
  commandId: `cmd-${seed}`,
  correlationId: correlationId(`corr-${seed}`),
  occurredAt: '2026-07-30T12:00:00Z',
  actor: { kind: 'operator' as const, id: 'test' },
});

function setup() {
  const journal = new InMemoryEventJournal(new FakeClock());
  return { journal, work: createWorkService(journal) };
}

it('extends its view with each journal move and keeps earlier snapshots unchanged', async () => {
  const { work } = setup();
  const id = workId('item');
  await work.create({ workItemId: id, objective: 'ship' }, context('create'));
  const before = await work.deliverySnapshot();
  expect(before.availability(id).reason).toBeUndefined();

  await work.freeze(id, context('freeze'));
  const after = await work.deliverySnapshot();

  expect(after.availability(id).reason).toBeDefined();
  expect(before.availability(id).reason).toBeUndefined();
  await work.unfreeze(id, context('unfreeze'));
  expect((await work.deliverySnapshot()).availability(id).reason).toBeUndefined();
});

it('holds only the item whose Work events are malformed and leaves every other item available', async () => {
  const { journal, work } = setup();
  const healthy = workId('healthy');
  const broken = workId('broken');
  await work.create({ workItemId: healthy, objective: 'ship' }, context('healthy'));
  await journal.appendToStream(workItemStream(broken), 0, [
    createEventData({
      eventId: 'bad-event',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'bad-event',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { not: 'a work payload' },
    }),
  ]);
  await work.create({ workItemId: workId('later'), objective: 'after' }, context('later'));

  const snapshot = await work.deliverySnapshot();

  expect(snapshot.invalid(broken)).toBe(true);
  expect(snapshot.invalid(healthy)).toBe(false);
  expect(snapshot.availability(healthy).reason).toBeUndefined();
  expect(snapshot.availability(workId('later')).reason).toBeUndefined();

  // The gate fails closed for the broken item even though it has no delegation or fence.
  const gate = new DelegationGate({} as never, work);
  const views = [broken, healthy].map((workItemId) => ({ workItemId })) as WorkflowInstanceView[];
  expect(await gate.filterAvailable(views, (view) => view)).toEqual([views[1]]);
});

it('restores a persisted snapshot instead of replaying work history, with identical results', async () => {
  const { journal, work } = setup();
  const store = new InMemoryViewSnapshotStore();
  registerViewSnapshotStore(journal, store);
  const id = workId('persisted');
  await work.create({ workItemId: id, objective: 'ship' }, context('create'));
  await work.freeze(id, context('freeze'));
  const first = new WorkIndex(journal, { minEvents: 1, minIntervalMs: 0 });
  const expected = await first.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const readAll = vi.spyOn(journal, 'readAll');

  const restored = await new WorkIndex(journal, { minEvents: 1, minIntervalMs: 0 }).snapshot();

  expect(restored.get(id)).toEqual(expected.get(id));
  expect(restored.availability(id)).toEqual(expected.availability(id));
  expect(readAll.mock.calls.every(([after]) => after > 0)).toBe(true);
});
