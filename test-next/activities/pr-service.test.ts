import { describe, expect, it } from 'vitest';

import {
  createPullRequestService,
  decidePullRequestAuthority,
} from '../../src-next/activities/index.js';
import { correlationId } from '../../src-next/kernel/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { createResourceService, resourceId } from '../../src-next/resources/index.js';
import { createWorkService, workItemId } from '../../src-next/work/index.js';
import { FakeClock } from '../e2e/support/world.js';

const resource = resourceId('resource-1');
const workItem = workItemId('work-1');

describe('PullRequestService', () => {
  it('emits typed state changes from a PR observation without an adapter constructing facts', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const resources = createResourceService(journal);
    const work = createWorkService(journal);
    await work.create({ workItemId: workItem, objective: 'Merge PR' }, context('work'));
    await resources.discover(
      {
        resourceId: resource,
        kind: 'pull-request',
        externalKey: { adapter: 'github', key: 'o/r#1' },
        capabilities: ['reviewable', 'revisioned'],
      },
      context('resource'),
    );
    await resources.correlate(resource, workItem, 'primary', context('correlation'));
    const service = createPullRequestService(journal, work, resources);

    await service.observe(
      {
        resourceId: resource,
        workItemId: workItem,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'pending',
      },
      context('observe-a'),
    );
    await service.observe(
      {
        resourceId: resource,
        workItemId: workItem,
        state: 'open',
        headRevision: 'head-b',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe-b'),
    );

    expect(
      (await journal.readStream({ kind: 'resource', id: resource })).map(
        (event) => event.eventType,
      ),
    ).toEqual([
      'resources.resource-discovered',
      'resources.work-correlation-established',
      'pr.discovered',
      'pr.revision-changed',
      'pr.checks-changed',
    ]);
  });
});

describe('PullRequestService review evidence', () => {
  it('rejects an accepted review when public resource conflict provenance is present', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const resources = createResourceService(journal);
    const work = createWorkService(journal);
    await work.create({ workItemId: workItem, objective: 'Merge PR' }, context('work'));
    await resources.discover(
      {
        resourceId: resource,
        kind: 'pull-request',
        externalKey: { adapter: 'github', key: 'o/r#1' },
        capabilities: ['reviewable', 'revisioned'],
      },
      context('resource'),
    );
    await resources.correlate(resource, workItem, 'primary', context('correlation'));
    const service = createPullRequestService(journal, work, resources);
    await service.observe(
      {
        resourceId: resource,
        workItemId: workItem,
        state: 'open',
        headRevision: 'head-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      context('observe'),
    );
    await expect(
      resources.correlate(resource, workItemId('work-2'), 'primary', context('conflict')),
    ).rejects.toThrow('primary');
    const publicResource = await resources.get(resource);
    expect(publicResource?.primaryCorrelationConflict).toMatchObject({
      attemptedWorkItemId: 'work-2',
    });

    await service.acceptReviewSignal(
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'review-a',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
      },
      context('accept'),
    );

    expect((await journal.readStream({ kind: 'resource', id: resource })).at(-1)?.eventType).toBe(
      'pr.review-rejected',
    );
    expect(
      decidePullRequestAuthority({
        work: await work.get(workItem),
        resources: [
          { resource: publicResource!, correlations: await resources.correlations(resource) },
        ],
        pullRequests: [(await service.get(resource))!],
        acceptedSignals: [],
      }),
    ).toEqual({ allowed: false, reason: 'correlation-conflict' });
  });
});

function context(commandId: string) {
  return {
    commandId,
    correlationId: correlationId('correlation-1'),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: 'integration' as const, id: 'github' },
  };
}
