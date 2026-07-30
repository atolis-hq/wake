import { expect, it } from 'vitest';

import {
  createPullRequestMergeAuthorityActivity,
  pullRequestProjection,
  decidePullRequestAuthority,
  type PullRequestAuthorityInput,
} from '../../../src-next/activities/index.js';
import { createEventDraft, entityRef } from '../../../src-next/kernel/index.js';
import { resourceId } from '../../../src-next/resources/index.js';
import { workItemId } from '../../../src-next/work/index.js';
import { TestWorld } from '../support/world.js';

it('E2E-PR-002 denies a merge after an accepted review becomes stale', async () => {
  const workItem = workItemId('work-1');
  const resource = resourceId('resource-1');
  const discovered = pullRequestProjection.project(
    pullRequestProjection.initial('resource-1'),
    prEvent(resource, 1, 'pr.discovered', {
      workItemId: workItem,
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
    }),
  );
  const accepted = pullRequestProjection.project(
    discovered,
    prEvent(resource, 2, 'pr.review-accepted', { revision: 'head-a', actorId: 'reviewer' }),
  );
  const pullRequest = pullRequestProjection.project(
    accepted,
    prEvent(resource, 3, 'pr.revision-changed', { headRevision: 'head-b', baseRevision: 'base-a' }),
  );
  const decision = decidePullRequestAuthority(authorityInput(pullRequest!));
  expect(decision).toEqual({ allowed: false, reason: 'stale-approval' });

  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge reviewed PR', workItemId: workItem });
  const context = {
    correlationId: 'scenario-1' as never,
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
  await world.resources.discover(
    {
      resourceId: resource,
      kind: 'pull-request',
      externalKey: { adapter: 'github', key: 'owner/repo#1' },
      capabilities: ['reviewable', 'revisioned'],
    },
    { ...context, commandId: 'resource' },
  );
  await world.resources.correlate(resource, workItem, 'primary', {
    ...context,
    commandId: 'correlation',
  });
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: workItem,
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
    },
    { ...context, commandId: 'observe-a' },
  );
  await world.pullRequests.acceptReviewSignal(
    {
      resourceId: resource,
      revision: 'head-a',
      actorId: 'reviewer',
      actorKind: 'human',
      acceptedEventId: 'review-a',
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
    },
    { ...context, commandId: 'review-a' },
  );
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: workItem,
      state: 'open',
      headRevision: 'head-b',
      baseRevision: 'base-a',
      checks: 'passing',
    },
    { ...context, commandId: 'observe-b' },
  );
  world.registerActivity(createPullRequestMergeAuthorityActivity(world.pullRequests));
  world.configureWorkflow('merge', {
    stages: {
      merge: {
        activity: 'pr.merge',
        with: {},
        on: { 'merge-denied': { then: 'merge', repeat: { max: 1 } } },
      },
    },
  });
  await world.startWorkflow({ workItemId: work.workItemId, workflowName: 'merge' });
  await world.advance(work.workItemId);
  await world.advance(work.workItemId);

  expect((await world.events()).map((event) => event.eventType)).toContain('pr.merge-denied');
  expect((await world.events()).map((event) => event.eventType)).toContain(
    'orchestration.instance-blocked',
  );
  expect((await world.events()).map((event) => event.eventType)).not.toContain(
    'pr.merge-requested',
  );
});

function authorityInput(
  pullRequest: NonNullable<ReturnType<typeof pullRequestProjection.project>>,
): PullRequestAuthorityInput {
  return {
    work: {
      workItemId: pullRequest.workItemId,
      objective: 'merge',
      state: 'open',
      relatedWorkItems: [],
    },
    resources: [
      {
        resource: {
          resourceId: pullRequest.resourceId,
          kind: 'pull-request',
          externalKey: { adapter: 'github', key: 'owner/repo#1' },
          capabilities: [],
        },
        correlations: [
          {
            resourceId: pullRequest.resourceId,
            workItemId: pullRequest.workItemId,
            role: 'primary',
            establishedByEventId: 'correlation-1',
          },
        ],
      },
    ],
    pullRequests: [pullRequest],
    acceptedSignals: [],
  };
}

function prEvent(
  resource: ReturnType<typeof resourceId>,
  position: number,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    ...createEventDraft({
      eventId: `event-${position}`,
      eventType,
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: `cause-${position}`,
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: entityRef('resource', resource),
      payload,
    }),
    globalPosition: position,
    sequence: position,
    recordedAt: '2026-07-30T12:00:00.000Z',
  };
}
