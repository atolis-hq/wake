import { describe, expect, it } from 'vitest';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import type { resourceId } from '../../../src/resources/index.js';
import { resourceCapability, resourceKind, resourceStream } from '../../../src/resources/index.js';
import {} from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

const context = (commandId: string) => ({
  commandId,
  correlationId: 'correlation-1' as never,
  actor: { kind: 'integration' as const, id: 'fake' },
  occurredAt: '2026-07-30T12:00:00.000Z',
});

describe('Resource correlations', () => {
  it('discovers any provider resource behind an opaque adapter key', async () => {
    const service = createTestResourceServices(new InMemoryEventJournal(new FakeClock())).resources;

    await service.discover(
      {
        resourceId: resId('one'),
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'fake', key: 'repo/pulls/7' },
        capabilities: [
          resourceCapability('reviewable'),
          resourceCapability('mergeable'),
          resourceCapability('revisioned'),
        ],
        revision: 'sha-a',
      },
      context('command-1'),
    );

    await expect(
      service.findByExternalKey({ adapter: 'fake', key: 'repo/pulls/7' }),
    ).resolves.toEqual({
      resourceId: resId('one'),
      kind: resourceKind('pull-request'),
      externalKey: { adapter: 'fake', key: 'repo/pulls/7' },
      capabilities: [
        resourceCapability('reviewable'),
        resourceCapability('mergeable'),
        resourceCapability('revisioned'),
      ],
      revision: 'sha-a',
    });
  });

  it('retains an optional title captured at discovery', async () => {
    const service = createTestResourceServices(new InMemoryEventJournal(new FakeClock())).resources;

    await service.discover(
      {
        resourceId: resId('titled'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'repo/issues/9' },
        capabilities: [resourceCapability('commentable')],
        title: 'Fix flaky checkout test',
      },
      context('command-1'),
    );

    await expect(service.get(resId('titled'))).resolves.toMatchObject({
      title: 'Fix flaky checkout test',
    });
  });

  it('correlates a Resource to a WorkItem using a registered relation definition', async () => {
    const service = createTestResourceServices(new InMemoryEventJournal(new FakeClock())).resources;
    const resource = resId('one');
    await service.discover(discovery(resource), context('command-1'));

    await expect(
      service.correlate(resource, workId('one'), 'primary', context('command-2')),
    ).resolves.toEqual({
      resourceId: resId('one'),
      workItemId: workId('one'),
      role: 'primary',
      provenance: 'provider-observed',
      establishedByEventId: 'command-2:resources.work-correlation-established',
    });
  });

  it('records why an agent-reported artifact was correlated', async () => {
    const service = createTestResourceServices(new InMemoryEventJournal(new FakeClock())).resources;
    const resource = resId('agent-reported');
    await service.discover(discovery(resource), context('discover'));

    await expect(
      service.correlate(resource, workId('one'), 'primary', context('correlate'), 'agent-reported'),
    ).resolves.toMatchObject({ provenance: 'agent-reported' });
  });

  it('repeating the same correlation is idempotent', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(journal).resources;
    const resource = resId('one');
    await service.discover(discovery(resource), context('command-1'));

    await service.correlate(resource, workId('one'), 'primary', context('command-2'));
    await service.correlate(resource, workId('one'), 'primary', context('command-2'));

    expect(
      (await journal.readStream(resourceStream(resId('one')))).filter(
        (event) => event.eventType === 'resources.work-correlation-established',
      ),
    ).toHaveLength(1);
  });

  it('rejects a second primary WorkItem correlation and records conflict evidence', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(journal).resources;
    const resource = resId('one');
    await service.discover(discovery(resource), context('command-1'));
    await service.correlate(resource, workId('one'), 'primary', context('command-2'));

    await expect(
      service.correlate(resource, workId('two'), 'primary', context('command-3')),
    ).rejects.toThrow('primary');
    expect((await journal.readStream(resourceStream(resId('one')))).at(-1)?.eventType).toBe(
      'resources.work-correlation-conflicted',
    );
  });

  it('permits explicit secondary correlation without changing the primary', async () => {
    const service = createTestResourceServices(new InMemoryEventJournal(new FakeClock())).resources;
    const resource = resId('one');
    await service.discover(discovery(resource), context('command-1'));
    await service.correlate(resource, workId('one'), 'primary', context('command-2'));
    await service.correlate(resource, workId('two'), 'secondary', context('command-3'));

    await expect(service.correlations(resource)).resolves.toEqual([
      expect.objectContaining({ workItemId: workId('one'), role: 'primary' }),
      expect.objectContaining({ workItemId: workId('two'), role: 'secondary' }),
    ]);
  });

  it('retracts a correlation without deleting either specialist entity', async () => {
    const service = createTestResourceServices(new InMemoryEventJournal(new FakeClock())).resources;
    const resource = resId('one');
    await service.discover(discovery(resource), context('command-1'));
    await service.correlate(resource, workId('one'), 'primary', context('command-2'));
    await service.retract(resource, workId('one'), context('command-3'));

    await expect(service.get(resource)).resolves.toMatchObject({ resourceId: resId('one') });
    await expect(service.correlations(resource)).resolves.toEqual([]);
  });
});

function discovery(resource: ReturnType<typeof resourceId>) {
  return {
    resourceId: resource,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'fake', key: 'repo/pulls/7' },
    capabilities: [
      resourceCapability('reviewable'),
      resourceCapability('mergeable'),
      resourceCapability('revisioned'),
    ] as const,
    revision: 'sha-a',
  };
}
