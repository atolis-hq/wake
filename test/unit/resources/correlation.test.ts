import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import type { resourceId } from '../../../src/resources/index.js';
import { resourceCapability, resourceKind, resourceStream } from '../../../src/resources/index.js';
import {} from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';
import { InterleavingEventJournal } from '../../support/interleaving-event-journal.js';
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
        (event) => event.event.eventType === 'resources.work-correlation-established',
      ),
    ).toHaveLength(1);
  });

  it('treats concurrent identical correlations as one idempotent Resource change', async () => {
    const inner = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(
      new InterleavingEventJournal(
        inner,
        (events) => events[0]?.eventType === 'resources.work-correlation-established',
      ),
    ).resources;
    const resource = resId('concurrent-replay');
    await service.discover(discovery(resource), context('discover'));

    const results = await Promise.all([
      service.correlate(resource, workId('one'), 'primary', context('correlate')),
      service.correlate(resource, workId('one'), 'primary', context('correlate')),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ workItemId: workId('one'), role: 'primary' }),
      expect.objectContaining({ workItemId: workId('one'), role: 'primary' }),
    ]);
    expect(
      (await inner.readStream(resourceStream(resource))).filter(
        (event) => event.event.eventType === 'resources.work-correlation-established',
      ),
    ).toHaveLength(1);
  });

  it('records the mandated conflict when primary correlations race', async () => {
    const inner = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(
      new InterleavingEventJournal(
        inner,
        (events) => events[0]?.eventType === 'resources.work-correlation-established',
      ),
    ).resources;
    const resource = resId('concurrent-primary');
    await service.discover(discovery(resource), context('discover'));

    const results = await Promise.allSettled([
      service.correlate(resource, workId('one'), 'primary', context('correlate-one')),
      service.correlate(resource, workId('two'), 'primary', context('correlate-two')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ message: expect.stringContaining('primary') }),
      }),
    ]);
    const events = await inner.readStream(resourceStream(resource));
    expect(
      events.filter((event) => event.event.eventType === 'resources.work-correlation-established'),
    ).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled')?.value.workItemId;
    const loser = winner === workId('one') ? workId('two') : workId('one');
    expect(events.at(-1)).toMatchObject({
      event: {
        eventType: 'resources.work-correlation-conflicted',
        payload: { workItemId: loser, existingWorkItemId: winner },
      },
    });
  });

  it('rejects reuse of a command event identity with different Resource data', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(journal).resources;
    const resource = resId('identity-conflict');
    await service.discover(discovery(resource), context('command-1'));
    await service.correlate(resource, workId('one'), 'primary', context('command-2'));

    await expect(
      service.correlate(resource, workId('two'), 'primary', context('command-2')),
    ).rejects.toThrow('has already been used with different content');
    expect(
      (await journal.readStream(resourceStream(resource))).filter(
        (event) => event.event.eventType === 'resources.work-correlation-established',
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
    expect((await journal.readStream(resourceStream(resId('one')))).at(-1)?.event.eventType).toBe(
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

  it('bounds missing-primary retries per resource and exposes the terminal fact', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(journal).resources;
    const resource = resId('unresolvable');
    await service.discover(discovery(resource), context('discover'));
    await service.noteMissingPrimaryCorrelation(
      resource,
      'no primary correlation',
      context('observe'),
    );

    await service.retryPendingWorkCorrelations();
    await service.retryPendingWorkCorrelations();
    await service.retryPendingWorkCorrelations();

    expect(await service.get(resource)).toMatchObject({ correlationStatus: 'unresolvable' });
    expect((await journal.readStream(resourceStream(resource))).at(-1)).toMatchObject({
      event: {
        eventType: 'resources.work-correlation-unresolvable',
        payload: { attemptCount: 4, lastFailureReason: 'no primary correlation' },
      },
    });
    await service.retryPendingWorkCorrelations();
    expect(
      (await journal.readStream(resourceStream(resource))).filter(
        (event) => event.event.eventType === 'resources.work-correlation-unresolvable',
      ),
    ).toHaveLength(1);
  });

  it('clears the projected unresolvable state when an operator establishes a primary correlation', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(journal).resources;
    const resource = resId('recover');
    await service.discover(discovery(resource), context('discover'));
    await service.noteMissingPrimaryCorrelation(
      resource,
      'no primary correlation',
      context('observe'),
    );
    await service.retryPendingWorkCorrelations();
    await service.retryPendingWorkCorrelations();
    await service.retryPendingWorkCorrelations();
    await service.correlate(resource, workId('recover'), 'primary', context('correlate'));

    expect(await service.get(resource)).not.toHaveProperty('correlationStatus');
  });

  it('starts a new missing-primary retry cycle after a recovered primary is retracted', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createTestResourceServices(journal).resources;
    const resource = resId('retry-after-retraction');
    const work = workId('recover');
    await service.discover(discovery(resource), context('discover'));
    await service.noteMissingPrimaryCorrelation(
      resource,
      'no primary correlation',
      context('observe-1'),
    );
    await service.retryPendingWorkCorrelations();
    await service.retryPendingWorkCorrelations();
    await service.retryPendingWorkCorrelations();
    await service.correlate(resource, work, 'primary', context('correlate'));
    await service.retract(resource, work, context('retract'));

    await service.noteMissingPrimaryCorrelation(
      resource,
      'no primary correlation',
      context('observe-2'),
    );

    expect((await journal.readStream(resourceStream(resource))).at(-1)).toMatchObject({
      event: {
        eventType: 'resources.work-correlation-retry-pending',
        payload: { attemptCount: 1, lastFailureReason: 'no primary correlation' },
      },
    });
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
