import { expect, it } from 'vitest';
import { ProjectionRebuilder, createProjectionProcessor } from '../../../src/eventing/index.js';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('rebuilds a projection with its stable projection consumer checkpoint', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'one'> = { kind: 'counter', id: 'one' };
  await journal.append(stream, 0, [draft(stream)]);
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const definition = {
    name: 'counts',
    select: () => ({ key: 'one' }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
  expect(createProjectionProcessor(definition, projections).consumer).toBe('projection:counts');
  await new ProjectionRebuilder(
    journal,
    projections,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
  ).rebuild(definition);
  expect(await projections.read<number>('counts', 'one')).toMatchObject({
    value: 1,
    lastGlobalPosition: 1,
  });
  expect(await checkpoints.load('projection:counts')).toBe(1);
});

function draft(stream: EntityRef) {
  return createEventDraft({
    eventId: 'one',
    eventType: 'counted',
    occurredAt: '2026-08-30T12:00:00.000Z',
    correlationId: 'correlation',
    causationId: 'causation',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload: {},
  });
}
