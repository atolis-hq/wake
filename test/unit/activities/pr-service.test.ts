import { describe, expect, it } from 'vitest';
import { resourceCapability, resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import {
  createPullRequestService,
  decidePullRequestAuthority,
} from '../../../src/activities/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

const resource = resId('1');
const workItem = workId('1');

describe('PullRequestService', () => {
  it('emits typed state changes from a PR observation without an adapter constructing facts', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const { resources } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    await work.create({ workItemId: workItem, objective: 'Merge PR' }, context('work'));
    await resources.discover(
      {
        resourceId: resource,
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'github', key: 'o/r#1' },
        capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
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
      (await journal.readStream(resourceStream(resource))).map((event) => event.event.eventType),
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
    const { resources } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    await work.create({ workItemId: workItem, objective: 'Merge PR' }, context('work'));
    await resources.discover(
      {
        resourceId: resource,
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'github', key: 'o/r#1' },
        capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
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
      resources.correlate(resource, workId('2'), 'primary', context('conflict')),
    ).rejects.toThrow('primary');
    const publicResource = await resources.get(resource);
    expect(publicResource?.primaryCorrelationConflict).toMatchObject({
      attemptedWorkItemId: workId('2'),
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

    expect((await journal.readStream(resourceStream(resource))).at(-1)?.event.eventType).toBe(
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

describe('PullRequestService.factsFor', () => {
  it('returns a resource stream events in journal order, excluding other resources', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const { resources } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const otherResource = resId('2');
    await work.create({ workItemId: workItem, objective: 'Merge PR' }, context('work'));
    for (const id of [resource, otherResource]) {
      await resources.discover(
        {
          resourceId: id,
          kind: resourceKind('pull-request'),
          externalKey: { adapter: 'github', key: `o/r#${id}` },
          capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
        },
        context(`resource-${id}`),
      );
      await resources.correlate(id, workItem, 'primary', context(`correlation-${id}`));
    }
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
    await service.observe(
      {
        resourceId: otherResource,
        workItemId: workItem,
        state: 'open',
        headRevision: 'head-x',
        baseRevision: 'base-x',
        checks: 'passing',
      },
      context('observe-other'),
    );

    const events = await service.factsFor(resource);

    expect(events.map((event) => event.event.eventType)).toEqual([
      'pr.discovered',
      'pr.revision-changed',
      'pr.checks-changed',
    ]);
    expect(events.every((event) => event.stream.id === resource)).toBe(true);
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
