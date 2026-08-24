import { expect, it } from 'vitest';
import { z } from 'zod';

import { ActivityExecutionKind, activityName } from '../../../src/activities/index.js';
import {
  OrchestrationEventType,
  WatchGateVerdictSignal,
  WorkflowStatus,
  watchId,
} from '../../../src/orchestration/index.js';
import { resourceCapability, resourceKind } from '../../../src/resources/index.js';
import { resId } from '../../support/identities.js';
import { TestWorld } from '../support/world.js';

it('uses the earliest matching primary-PR fact before a later watch verdict', async () => {
  const world = new TestWorld();
  const resourceId = resId('1');
  world.registerActivity({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  });
  world.registerActivity({
    name: activityName('after-merge'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  });
  const work = await world.createWork({ objective: 'event transition' });
  await world.discoverResource({
    resourceId,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'github', key: 'owner/repo#1' },
    capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
  });
  await world.correlateResource(resourceId, work.workItemId, 'primary');
  await world.observePullRequest({
    resourceId,
    workItemId: work.workItemId,
    state: 'open',
    headRevision: 'a',
    baseRevision: 'base',
    checks: 'passing',
  });
  for (let index = 0; index < 101; index += 1)
    await world.appendFact('test.backlog', { index }, `backlog-${index}`);
  await world.observePullRequest({
    resourceId,
    workItemId: work.workItemId,
    state: 'closed',
    headRevision: 'a',
    baseRevision: 'base',
    checks: 'passing',
  });
  await world.observePullRequest({
    resourceId,
    workItemId: work.workItemId,
    state: 'merged',
    headRevision: 'a',
    baseRevision: 'base',
    checks: 'passing',
  });
  world.configureWorkflow('review', {
    stages: { review: { activity: 'implement', with: {}, on: { done: { then: 'done' } } } },
  });
  world.configureWorkflow('main', {
    stages: {
      implement: {
        activity: 'implement',
        with: {},
        on: {
          done: {
            then: 'done',
            watchGates: ['review'],
            resourceTransitions: [
              { events: ['pr.state-changed'], where: { state: 'merged' }, then: 'after-merge' },
            ],
          },
        },
      },
      'after-merge': { activity: 'after-merge', with: {}, on: { done: { then: 'done' } } },
    },
    watches: [
      {
        id: 'review',
        while: { stages: ['implement'], statuses: ['waiting'] },
        on: { events: ['review.requested'] },
        workflow: 'review',
        maxPerGroup: 1,
      },
    ],
  });
  const started = await world.startWorkflow({ workItemId: work.workItemId, workflowName: 'main' });
  await world.acceptOutcome(started.workflowInstanceId, started.pendingActivation!.activationId, {
    kind: 'done',
  });
  const laterVerdict = await world.appendFact('review.verdict', {}, 'later-watch-verdict');
  await world.acceptSignal(started.workflowInstanceId, {
    kind: WatchGateVerdictSignal,
    actorId: 'reviewer',
    actorDecision: { authorized: true, evidenceId: laterVerdict.eventId },
    providerEventId: laterVerdict.eventId,
    authority: { kind: 'watch', watch: watchId('review') },
    outcome: 'done',
  });
  expect((await world.orchestration.get(started.workflowInstanceId))?.currentStage).toBe(
    'after-merge',
  );
});

it('resolves a resource transition when the work item holds a second, non-matching primary resource', async () => {
  const world = new TestWorld();
  const issueResourceId = resId('1');
  const pullRequestResourceId = resId('2');
  world.registerActivity({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  });
  world.registerActivity({
    name: activityName('after-merge'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  });
  const work = await world.createWork({ objective: 'event transition' });
  // The originating issue resource is correlated primary, as it is at intake.
  await world.discoverResource({
    resourceId: issueResourceId,
    kind: resourceKind('issue'),
    externalKey: { adapter: 'github', key: 'owner/repo#1' },
    capabilities: [resourceCapability('completable'), resourceCapability('commentable')],
  });
  await world.correlateResource(issueResourceId, work.workItemId, 'primary');
  // The implementation PR is also correlated primary, as artifact registration does.
  await world.discoverResource({
    resourceId: pullRequestResourceId,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'github', key: 'owner/repo#2' },
    capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
  });
  await world.correlateResource(pullRequestResourceId, work.workItemId, 'primary');
  await world.observePullRequest({
    resourceId: pullRequestResourceId,
    workItemId: work.workItemId,
    state: 'open',
    headRevision: 'a',
    baseRevision: 'base',
    checks: 'passing',
  });
  world.configureWorkflow('main', {
    stages: {
      implement: {
        activity: 'implement',
        with: {},
        on: {
          done: {
            then: 'done',
            resourceTransitions: [
              { events: ['pr.state-changed'], where: { state: 'merged' }, then: 'after-merge' },
            ],
          },
        },
      },
      'after-merge': { activity: 'after-merge', with: {}, on: { done: { then: 'done' } } },
    },
  });
  const started = await world.startWorkflow({ workItemId: work.workItemId, workflowName: 'main' });
  await world.acceptOutcome(started.workflowInstanceId, started.pendingActivation!.activationId, {
    kind: 'done',
  });
  await world.observePullRequest({
    resourceId: pullRequestResourceId,
    workItemId: work.workItemId,
    state: 'merged',
    headRevision: 'a',
    baseRevision: 'base',
    checks: 'passing',
  });
  await world.advance();
  expect((await world.orchestration.get(started.workflowInstanceId))?.currentStage).toBe(
    'after-merge',
  );
});

it('waits after auto-merge delivery confirmation until the primary PR merges', async () => {
  const world = new TestWorld();
  const resourceId = resId('auto-merge');
  for (const name of ['pr.merge', 'complete-issue']) {
    world.registerActivity({
      name: activityName(name),
      inputSchema: z.unknown(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: ActivityExecutionKind.Deterministic,
      handler: {
        async execute() {
          return { kind: 'done' } as const;
        },
      },
    });
  }
  const work = await world.createWork({ objective: 'auto-merge waits for merge fact' });
  await world.discoverResource({
    resourceId,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'github', key: 'owner/repo#auto-merge' },
    capabilities: [resourceCapability('mergeable'), resourceCapability('revisioned')],
  });
  await world.correlateResource(resourceId, work.workItemId, 'primary');
  await world.observePullRequest({
    resourceId,
    workItemId: work.workItemId,
    state: 'open',
    headRevision: 'a',
    baseRevision: 'base',
    checks: 'pending',
  });
  world.configureWorkflow('main', {
    stages: {
      merge: {
        activity: 'pr.merge',
        with: {
          target: 'primary',
          method: 'squash',
          requireApproval: false,
          requireChecks: true,
          autoMerge: true,
        },
        on: {
          done: {
            then: 'wait',
            resourceTransitions: [
              {
                events: ['pr.state-changed'],
                where: { state: 'merged' },
                then: 'complete-issue',
              },
            ],
          },
        },
        requiresApproval: false,
      },
      'complete-issue': {
        activity: 'complete-issue',
        with: {},
        on: { done: { then: 'done' } },
        requiresApproval: false,
      },
    },
  });
  const started = await world.startWorkflow({ workItemId: work.workItemId, workflowName: 'main' });
  await world.acceptOutcome(started.workflowInstanceId, started.pendingActivation!.activationId, {
    kind: 'done',
  });

  const waiting = await world.orchestration.get(started.workflowInstanceId);
  expect(waiting?.status).toBe(WorkflowStatus.Waiting);
  expect(waiting?.currentStage).toBe('merge');
  expect(
    (
      await world.journal.readStream({ kind: 'workflow-instance', id: started.workflowInstanceId })
    ).filter((event) => event.eventType === OrchestrationEventType.ActivityRequested),
  ).toHaveLength(1);

  await world.observePullRequest({
    resourceId,
    workItemId: work.workItemId,
    state: 'merged',
    headRevision: 'a',
    baseRevision: 'base',
    checks: 'passing',
  });
  await world.advance();
  await world.advance();

  expect((await world.orchestration.get(started.workflowInstanceId))?.status).toBe(
    WorkflowStatus.Completed,
  );
  expect(
    (await world.journal.readStream({ kind: 'workflow-instance', id: started.workflowInstanceId }))
      .filter((event) => event.eventType === OrchestrationEventType.StageEntered)
      .map((event) => event.payload),
  ).toEqual([{ stage: 'merge' }, { stage: 'complete-issue' }]);
});
