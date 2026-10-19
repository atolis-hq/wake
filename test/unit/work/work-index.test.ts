import { correlationId, createEventData } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { DelegationGate } from '../../../src/orchestration/application/delegation-gate.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
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
