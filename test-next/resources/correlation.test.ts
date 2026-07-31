import { describe, expect, it } from 'vitest';
import {
  createResourceService,
  resourceId,
  resourceStream,
} from '../../src-next/resources/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { workItemId } from '../../src-next/work/index.js';
import { FakeClock } from '../e2e/support/world.js';

const context = (commandId: string) => ({
  commandId,
  correlationId: 'correlation-1' as never,
  actor: { kind: 'integration' as const, id: 'fake' },
  occurredAt: '2026-07-30T12:00:00.000Z',
});

describe('Resource correlations', () => {
  it('discovers any provider resource behind an opaque adapter key', async () => {
    const service = createResourceService(new InMemoryEventJournal(new FakeClock()));

    await service.discover(
      {
        resourceId: resourceId('resource-1'),
        kind: 'pull-request',
        externalKey: { adapter: 'fake', key: 'repo/pulls/7' },
        capabilities: ['reviewable', 'mergeable', 'revisioned'],
        revision: 'sha-a',
      },
      context('command-1'),
    );

    await expect(
      service.findByExternalKey({ adapter: 'fake', key: 'repo/pulls/7' }),
    ).resolves.toEqual({
      resourceId: 'resource-1',
      kind: 'pull-request',
      externalKey: { adapter: 'fake', key: 'repo/pulls/7' },
      capabilities: ['reviewable', 'mergeable', 'revisioned'],
      revision: 'sha-a',
    });
  });

  it('correlates a Resource to a WorkItem using a registered relation definition', async () => {
    const service = createResourceService(new InMemoryEventJournal(new FakeClock()));
    const resource = resourceId('resource-1');
    await service.discover(discovery(resource), context('command-1'));

    await expect(
      service.correlate(resource, workItemId('work-1'), 'primary', context('command-2')),
    ).resolves.toEqual({
      resourceId: 'resource-1',
      workItemId: 'work-1',
      role: 'primary',
      establishedByEventId: 'command-2:resources.work-correlation-established',
    });
  });

  it('repeating the same correlation is idempotent', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createResourceService(journal);
    const resource = resourceId('resource-1');
    await service.discover(discovery(resource), context('command-1'));

    await service.correlate(resource, workItemId('work-1'), 'primary', context('command-2'));
    await service.correlate(resource, workItemId('work-1'), 'primary', context('command-2'));

    expect(
      (await journal.readStream(resourceStream(resourceId('resource-1')))).filter(
        (event) => event.eventType === 'resources.work-correlation-established',
      ),
    ).toHaveLength(1);
  });

  it('rejects a second primary WorkItem correlation and records conflict evidence', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createResourceService(journal);
    const resource = resourceId('resource-1');
    await service.discover(discovery(resource), context('command-1'));
    await service.correlate(resource, workItemId('work-1'), 'primary', context('command-2'));

    await expect(
      service.correlate(resource, workItemId('work-2'), 'primary', context('command-3')),
    ).rejects.toThrow('primary');
    expect(
      (await journal.readStream(resourceStream(resourceId('resource-1')))).at(-1)?.eventType,
    ).toBe('resources.work-correlation-conflicted');
  });

  it('permits explicit secondary correlation without changing the primary', async () => {
    const service = createResourceService(new InMemoryEventJournal(new FakeClock()));
    const resource = resourceId('resource-1');
    await service.discover(discovery(resource), context('command-1'));
    await service.correlate(resource, workItemId('work-1'), 'primary', context('command-2'));
    await service.correlate(resource, workItemId('work-2'), 'secondary', context('command-3'));

    await expect(service.correlations(resource)).resolves.toEqual([
      expect.objectContaining({ workItemId: 'work-1', role: 'primary' }),
      expect.objectContaining({ workItemId: 'work-2', role: 'secondary' }),
    ]);
  });

  it('retracts a correlation without deleting either specialist entity', async () => {
    const service = createResourceService(new InMemoryEventJournal(new FakeClock()));
    const resource = resourceId('resource-1');
    await service.discover(discovery(resource), context('command-1'));
    await service.correlate(resource, workItemId('work-1'), 'primary', context('command-2'));
    await service.retract(resource, workItemId('work-1'), context('command-3'));

    await expect(service.get(resource)).resolves.toMatchObject({ resourceId: 'resource-1' });
    await expect(service.correlations(resource)).resolves.toEqual([]);
  });
});

function discovery(resource: ReturnType<typeof resourceId>) {
  return {
    resourceId: resource,
    kind: 'pull-request',
    externalKey: { adapter: 'fake', key: 'repo/pulls/7' },
    capabilities: ['reviewable', 'mergeable', 'revisioned'] as const,
    revision: 'sha-a',
  };
}
