import {
  createProjectionProcessor,
  EventProcessorHost,
  ProjectionRebuilder,
} from '@atolis-hq/eventing';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import {
  externalKeyProjectionKey,
  resourcesByExternalKeyProjection,
  workCorrelationsProjection,
} from '../../../src/resources/application/lookup-projections.js';
import { createResourceLookup } from '../../../src/resources/application/resource-lookup.js';
import {
  createResourceService,
  resourceCapability,
  resourceKind,
} from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

const context = (commandId: string) => ({
  commandId,
  correlationId: 'lookup' as never,
  actor: { kind: 'integration' as const, id: 'fake' },
  occurredAt: '2026-08-01T12:00:00.000Z',
});
const key = (value: string) => ({ adapter: 'fake', key: value });

describe('ResourceLookup projections', () => {
  it('projects one resource id per external key', async () => {
    const world = createWorld();
    const resource = resId('lookup-one');
    await world.resources.discover(discovery(resource, key('one')), context('discover'));
    await catchUp(world);
    await expect(world.lookup.resourceIdForExternalKey(key('one'))).resolves.toBe(resource);
  });
  it('returns null for an unknown external key', async () => {
    await expect(createWorld().lookup.resourceIdForExternalKey(key('missing'))).resolves.toBeNull();
  });
  it('uses a filesystem-safe projection key for repository-scoped external keys', () => {
    expect(externalKeyProjectionKey(key('atolis-hq/wake-test#27'))).not.toMatch(/[\\/]/);
  });
  it('projects correlated resource ids and roles per WorkItem', async () => {
    const world = createWorld();
    const resource = resId('lookup-correlated');
    const work = workId('lookup-work');
    await world.resources.discover(discovery(resource, key('correlated')), context('discover'));
    await world.resources.correlate(resource, work, 'primary', context('correlate'));
    await catchUp(world);
    await expect(world.lookup.correlationsForWork(work)).resolves.toEqual([
      expect.objectContaining({ resourceId: resource, workItemId: work, role: 'primary' }),
    ]);
  });
  it('drops a retracted correlation from the WorkItem entry', async () => {
    const world = createWorld();
    const resource = resId('lookup-retracted');
    const work = workId('retracted-work');
    await world.resources.discover(discovery(resource, key('retracted')), context('discover'));
    await world.resources.correlate(resource, work, 'primary', context('correlate'));
    await world.resources.retract(resource, work, context('retract'));
    await catchUp(world);
    await expect(world.lookup.correlationsForWork(work)).resolves.toEqual([]);
  });
  it('resolves a resource discovered after the projection checkpoint from the journal tail', async () => {
    const world = createWorld();
    await catchUp(world);
    const resource = resId('lookup-tail');
    await world.resources.discover(discovery(resource, key('tail')), context('discover'));
    await expect(world.lookup.resourceIdForExternalKey(key('tail'))).resolves.toBe(resource);
  });
  it('rebuilds identically to the live fold after the projection store is cleared', async () => {
    const world = createWorld();
    const resource = resId('lookup-rebuild');
    const work = workId('rebuild-work');
    await world.resources.discover(discovery(resource, key('rebuild')), context('discover'));
    await world.resources.correlate(resource, work, 'primary', context('correlate'));
    await catchUp(world);
    const before = await world.lookup.correlationsForWork(work);
    await world.projections.clear();
    await world.rebuilder.rebuild(resourcesByExternalKeyProjection);
    await world.rebuilder.rebuild(workCorrelationsProjection);
    await expect(world.lookup.correlationsForWork(work)).resolves.toEqual(before);
  });
});

function createWorld() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const serialiseRun = createInMemoryProcessorRunSerialiser();
  const lookup = createResourceLookup({ journal, projections });
  return {
    resources: createResourceService(journal, lookup),
    lookup,
    projections,
    projectionHost: new EventProcessorHost(journal, checkpoints, serialiseRun, new FakeClock()),
    rebuilder: new ProjectionRebuilder(journal, projections, checkpoints, serialiseRun),
  };
}

async function catchUp(world: ReturnType<typeof createWorld>) {
  await world.projectionHost.runOnce(
    createProjectionProcessor(resourcesByExternalKeyProjection, world.projections),
  );
  await world.projectionHost.runOnce(
    createProjectionProcessor(workCorrelationsProjection, world.projections),
  );
}

function discovery(
  resourceId: ReturnType<typeof resId>,
  externalKey: { adapter: string; key: string },
) {
  return {
    resourceId,
    kind: resourceKind('issue'),
    externalKey,
    capabilities: [resourceCapability('commentable')] as const,
  };
}
