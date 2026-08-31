import { expect, it } from 'vitest';
import { activityName, PullRequestDenialCode } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { resourceCapability, resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

import { correlationId, WrongExpectedSequenceError, type EventJournal } from '@atolis-hq/eventing';
import { InProcessJournalChangeSignal } from '@atolis-hq/eventing/memory';
import { activationId, createPullRequestMergeActivity } from '../../../src/activities/index.js';
import { mergeDenied } from '../../../src/activities/pr/event-data.js';
import { appendIntentOnce } from '../../../src/activities/pr/intent.js';
import {} from '../../../src/resources/index.js';
import type { workItemId } from '../../../src/work/index.js';
import { workItemStream } from '../../../src/work/index.js';
import { TestWorld } from '../../e2e/support/world.js';

it('returns failed when the append boundary reports a definite failure', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  await setupApprovedPullRequest(world, work.workItemId);
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests, {
    async append() {
      return 'failed';
    },
  });

  await expect(activity.handler.execute(invocation(work.workItemId), context())).resolves.toEqual({
    kind: 'failed',
    data: { reason: 'intent-write-failed' },
  });
  expect(await world.events('pr.merge-requested')).toHaveLength(0);
});

it('fails rather than waiting when an ambiguous denial append cannot be found', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests, {
    async append() {
      return 'ambiguous';
    },
  });

  await expect(
    activity.handler.execute({ ...invocation(work.workItemId), resources: [] }, context()),
  ).resolves.toEqual({
    kind: 'failed',
    data: { reason: 'intent-write-failed' },
  });
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
});

it('queries by event id before trusting a genuinely uncertain requested append', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  await setupApprovedPullRequest(world, work.workItemId);
  let reconciliationReads = 0;
  const queryingJournal: EventJournal = {
    appendToStream: (stream, sequence, events) =>
      world.journal.appendToStream(stream, sequence, events),
    readAll: (position, limit) => world.journal.readAll(position, limit),
    readStream(stream) {
      reconciliationReads += 1;
      return world.journal.readStream(stream);
    },
    latestGlobalPosition: () => world.journal.latestGlobalPosition(),
    waitForEventsAfter: world.journal.waitForEventsAfter.bind(world.journal),
    changeSignal: world.journal.changeSignal,
  };
  const activity = createPullRequestMergeActivity(queryingJournal, world.pullRequests, {
    async append(stream, intent) {
      const events = await world.journal.readStream(stream);
      await world.journal.appendToStream(stream, events.length, [intent]);
      return 'ambiguous';
    },
  });

  await expect(activity.handler.execute(invocation(work.workItemId), context())).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.merge-requested',
      signalKind: signalName('delivery-result'),
    },
  });
  expect(reconciliationReads).toBeGreaterThan(0);
  expect(await world.events('pr.merge-requested')).toHaveLength(1);
});

it('treats exhausted sequence conflicts without the event as a failed append', async () => {
  const stream = workItemStream(workId('1'));
  let attempts = 0;
  const journal: EventJournal = {
    async appendToStream() {
      attempts += 1;
      throw new WrongExpectedSequenceError('conflict');
    },
    async readStream() {
      return [];
    },
    async readAll() {
      return [];
    },
    async latestGlobalPosition() {
      return 0;
    },
    async waitForEventsAfter() {},
    changeSignal: new InProcessJournalChangeSignal(),
  };
  const intent = mergeDenied(PullRequestDenialCode.MissingResource, {
    commandId: 'activation-1',
    occurredAt: '2026-07-30T12:00:00.000Z',
    correlationId: correlationId('scenario-1'),
    actor: { kind: 'system', id: 'test' },
  });

  await expect(appendIntentOnce(journal, stream, intent)).resolves.toBe('failed');
  expect(attempts).toBe(3);
});

async function setupApprovedPullRequest(
  world: TestWorld,
  work: ReturnType<typeof workItemId>,
): Promise<void> {
  const resource = resId('1');
  await world.discoverResource({
    resourceId: resource,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'neutral-test', key: 'pr-1' },
    capabilities: [
      resourceCapability('reviewable'),
      resourceCapability('mergeable'),
      resourceCapability('revisioned'),
    ],
  });
  await world.resources.correlate(resource, work, 'primary', command(world, 'correlate'));
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: work,
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
    },
    command(world, 'observe'),
  );
  await world.pullRequests.acceptReviewSignal(
    {
      resourceId: resource,
      revision: 'head-a',
      actorId: 'reviewer',
      actorKind: 'human',
      acceptedEventId: 'review-1',
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
    },
    command(world, 'approve'),
  );
}

function invocation(work: ReturnType<typeof workItemId>) {
  return {
    activationId: activationId('activation-1'),
    activity: activityName('pr.merge'),
    workItemId: work,
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    causationId: 'activation-1',
    input: {
      target: 'primary' as const,
      method: 'merge' as const,
      requireChecks: true,
      blockedPaths: [],
    },
    resources: [
      {
        resourceId: resId('1'),
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'neutral-test', key: 'pr-1' },
        capabilities: [resourceCapability('mergeable'), resourceCapability('revisioned')] as const,
      },
    ],
  };
}

function context() {
  return {
    occurredAt: '2026-07-30T12:10:00.000Z',
    signal: new AbortController().signal,
    async reportExternalExecution() {},
  };
}

function command(world: TestWorld, commandId: string) {
  return {
    commandId,
    correlationId: 'scenario-1' as never,
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
}
