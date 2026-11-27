import { createEventData } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  ResourceEventType,
  ResourceIndex,
  resourceId,
  resourceKind,
  resourceStream,
} from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const good = resourceId('resource-00000000000000000000000001');
const bad = resourceId('resource-00000000000000000000000002');
const work = workId('item');

function draft(id: string, eventType: string, payload: unknown) {
  return createEventData({
    eventId: `${id}:${eventType}`,
    eventType,
    occurredAt: '2026-08-01T12:00:00Z',
    correlationId: 'c',
    causationId: 'c',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload,
  } as never);
}

const discovered = (id: string) =>
  draft(id, ResourceEventType.ResourceDiscovered, {
    kind: resourceKind('issue'),
    externalKey: { adapter: 'github', key: `org/repo#${id.slice(-1)}` },
    capabilities: [],
  });

it('tracks keys and active correlations incrementally and poisons only a malformed resource', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const index = new ResourceIndex(journal);
  await journal.appendToStream(resourceStream(good), 0, [discovered(good)]);
  await journal.appendToStream(resourceStream(good), 1, [
    draft(good, ResourceEventType.WorkCorrelationEstablished, {
      workItemId: work,
      role: ResourceCorrelationRole.Primary,
      provenance: ResourceCorrelationProvenance.OperatorDeclared,
    }),
  ]);
  const before = await index.snapshot();
  expect(before.externalKey(good)).toEqual({ adapter: 'github', key: 'org/repo#1' });
  expect(before.correlationsForWork(work).map((c) => c.resourceId)).toEqual([good]);
  expect(before.correlations(good)).toHaveLength(1);

  await journal.appendToStream(resourceStream(bad), 0, [
    draft(bad, ResourceEventType.ResourceDiscovered, { not: 'a resource' }),
  ]);
  await journal.appendToStream(resourceStream(good), 2, [
    draft(good, ResourceEventType.WorkCorrelationRetracted, { workItemId: work }),
  ]);
  const after = await index.snapshot();

  expect(after.externalKey(bad)).toBeNull();
  expect(after.externalKey(good)).not.toBeNull();
  expect(after.correlations(good)).toEqual([]);
  expect(after.correlationsForWork(work)).toEqual([]);
  expect(before.correlations(good)).toHaveLength(1);
});
