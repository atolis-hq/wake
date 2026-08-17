import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  activityName,
  ActivityOutcomeKind,
  ProviderPermission,
  ReviewActorKind,
  ReviewerAuthorizationSource,
} from '../../../../src/activities/index.js';
import { applyReviewSignal } from '../../../../src/integrations/github/application/inbound-review-signals.js';
import {
  GitHubEventType,
  type GitHubAdapterEvent,
} from '../../../../src/integrations/github/contracts/events.js';
import { GitHubAdapter } from '../../../../src/integrations/github/contracts/vocabulary.js';
import { correlationId } from '../../../../src/kernel/index.js';
import {
  OperatorRetryIneligibleError,
  signalName,
  stageName,
  TransitionTargetKind,
  WatchGateVerdictSignal,
  workflowName,
} from '../../../../src/orchestration/index.js';
import { resourceCapability, resourceKind } from '../../../../src/resources/index.js';
import { TestWorld } from '../../../e2e/support/world.js';

it('ignores an unrecognized slash-prefixed issue command', async () => {
  expect(await issueCommentSignals('/ask what should happen next?')).toEqual([]);
});

it('recognizes a normalized /approved issue command', async () => {
  expect(await issueCommentSignals('  /ApPrOvEd  ')).toHaveLength(1);
});

it('recognizes /changes with feedback as an issue command', async () => {
  expect(await issueCommentSignals('/changes please retry the error handling')).toHaveLength(1);
});

it('retries an open primary workflow only for a provider-authorized /retry comment', async () => {
  const retried: unknown[] = [];
  const event = issueCommentEvent('/retry');
  await applyReviewSignal({
    event: {
      ...event,
      payload: {
        ...event.payload,
        authorization: {
          source: ReviewerAuthorizationSource.ProviderPermission,
          permission: ProviderPermission.Write,
        },
      },
    } as never,
    journal: {} as never,
    resources: {
      async correlations() {
        return [{ role: 'primary', workItemId: 'work-7' }];
      },
      async get() {
        return { kind: resourceKind('issue') };
      },
    } as never,
    work: {
      async get() {
        return { state: 'open', frozen: false, deleted: false };
      },
    } as never,
    lookup: {
      async resourceIdForExternalKey() {
        return 'resource-7';
      },
    } as never,
    pullRequests: undefined,
    ids: {} as never,
    adapter: GitHubAdapter,
    orchestration: {
      async listForWorkItem(workItemId: string) {
        expect(workItemId).toBe('work-7');
        return [
          {
            workflowInstanceId: 'workflow-7',
            workItemId: 'work-7',
            status: 'blocked',
            blockReason: 'unconfigured outcome failed',
            pendingActivation: {
              activationId: 'workflow-7:activity:1',
              status: 'completed',
              supplemental: false,
            },
            lastOutcome: { kind: 'failed' },
            acceptedOutcomes: ['workflow-7:activity:1'],
          },
        ];
      },
      async retryBlockedFailedStage(...input: unknown[]) {
        retried.push(input);
      },
    } as never,
  });

  expect(retried).toHaveLength(1);
  expect(retried[0]).toMatchObject([
    'workflow-7',
    { commandId: 'github:issue-comment:atolis-hq/wake-test#7:99:2026-08-08T00:00:00Z:inbound' },
  ]);
});

it('retries the eligible child for the exact waiting watch on an authorized /retry comment', async () => {
  const retried: unknown[] = [];
  await applyReviewSignal({
    event: {
      ...issueCommentEvent('/retry'),
      payload: {
        ...issueCommentEvent('/retry').payload,
        authorization: {
          source: ReviewerAuthorizationSource.ProviderPermission,
          permission: ProviderPermission.Write,
        },
      },
    } as never,
    journal: {} as never,
    resources: {
      async correlations() {
        return [{ role: 'primary', workItemId: 'work-7' }];
      },
      async get() {
        return { kind: resourceKind('issue') };
      },
    } as never,
    work: {
      async get() {
        return { state: 'open', frozen: false, deleted: false };
      },
    } as never,
    lookup: {
      async resourceIdForExternalKey() {
        return 'resource-7';
      },
    } as never,
    pullRequests: undefined,
    ids: {} as never,
    adapter: GitHubAdapter,
    orchestration: {
      async listForWorkItem(workItemId: string) {
        expect(workItemId).toBe('work-7');
        return [
          {
            workflowInstanceId: 'primary-7',
            workItemId: 'work-7',
            orchestrationGroupId: 'group-7',
            status: 'waiting',
            waitingFor: {
              signalKind: WatchGateVerdictSignal,
              from: [{ kind: 'watch', watch: 'plan-review' }],
            },
          },
          {
            workflowInstanceId: 'child-7',
            workItemId: 'work-7',
            orchestrationGroupId: 'group-7',
            parentWorkflowInstanceId: 'primary-7',
            watchId: 'plan-review',
            status: 'blocked',
            blockReason: 'unconfigured outcome failed',
            pendingActivation: {
              activationId: 'child-7:activity:1',
              status: 'completed',
              supplemental: false,
            },
            lastOutcome: { kind: 'failed' },
            acceptedOutcomes: ['child-7:activity:1'],
          },
        ];
      },
      async retryBlockedFailedStage(...input: unknown[]) {
        retried.push(input);
      },
    } as never,
  });

  expect(retried).toHaveLength(1);
  expect((retried[0] as unknown[] | undefined)?.[0]).toBe('child-7');
});

it('ignores an ineligible authorized /retry command', async () => {
  await expect(
    applyReviewSignal({
      event: {
        ...issueCommentEvent('/retry'),
        payload: {
          ...issueCommentEvent('/retry').payload,
          authorization: {
            source: ReviewerAuthorizationSource.ProviderPermission,
            permission: ProviderPermission.Write,
          },
        },
      } as never,
      journal: {} as never,
      resources: {
        async correlations() {
          return [{ role: 'primary', workItemId: 'work-7' }];
        },
        async get() {
          return { kind: resourceKind('issue') };
        },
      } as never,
      work: {
        async get() {
          return { state: 'open', frozen: false, deleted: false };
        },
      } as never,
      lookup: {
        async resourceIdForExternalKey() {
          return 'resource-7';
        },
      } as never,
      pullRequests: undefined,
      ids: {} as never,
      adapter: GitHubAdapter,
      orchestration: {
        async listForWorkItem(workItemId: string) {
          expect(workItemId).toBe('work-7');
          return [{ workflowInstanceId: 'workflow-7', workItemId: 'work-7' }];
        },
        async retryBlockedFailedStage() {
          throw new OperatorRetryIneligibleError('workflow is not retryable');
        },
      } as never,
    }),
  ).resolves.toBeUndefined();
});

it('fails closed for a /retry comment without collaborator permission evidence', async () => {
  const retried: unknown[] = [];
  await applyReviewSignal({
    event: issueCommentEvent('/retry'),
    journal: {} as never,
    resources: {
      async correlations() {
        return [{ role: 'primary', workItemId: 'work-7' }];
      },
      async get() {
        return { kind: resourceKind('issue') };
      },
    } as never,
    work: {
      async get() {
        return { state: 'open', frozen: false, deleted: false };
      },
    } as never,
    lookup: {
      async resourceIdForExternalKey() {
        return 'resource-7';
      },
    } as never,
    pullRequests: undefined,
    ids: {} as never,
    adapter: GitHubAdapter,
    orchestration: {
      async listAll() {
        return [{ workflowInstanceId: 'workflow-7', workItemId: 'work-7' }];
      },
      async retryBlockedFailedStage(...input: unknown[]) {
        retried.push(input);
      },
    } as never,
  });

  expect(retried).toEqual([]);
});

it('resumes an eligible blocked issue workflow on /changes', async () => {
  const resumes: unknown[] = [];

  await applyReviewSignal({
    event: issueCommentEvent('/changes clarify the closure provenance'),
    journal: {} as never,
    resources: {
      async correlations() {
        return [{ role: 'primary', workItemId: 'work-7' }];
      },
      async get() {
        return { kind: resourceKind('issue') };
      },
    } as never,
    work: {
      async get() {
        return { state: 'open', frozen: false, deleted: false };
      },
    } as never,
    lookup: {
      async resourceIdForExternalKey() {
        return 'resource-7';
      },
    } as never,
    pullRequests: undefined,
    ids: {} as never,
    adapter: GitHubAdapter,
    orchestration: {
      async listAll() {
        return [{ workflowInstanceId: 'workflow-7', workItemId: 'work-7', status: 'blocked' }];
      },
      async resumeBlockedStageForChanges(...input: unknown[]) {
        resumes.push(input);
      },
    } as never,
  });

  expect(resumes).toHaveLength(1);
  expect(resumes[0]).toMatchObject([
    'workflow-7',
    { commandId: 'github:issue-comment:atolis-hq/wake-test#7:99:2026-08-08T00:00:00Z:inbound' },
  ]);
});

it('satisfies a watchGate wait with /approved using its own signal kind', async () => {
  const fixture = await waitingIssueWorkflow(WatchGateVerdictSignal);

  await applyHumanIssueCommand(fixture, '/approved');

  expect((await fixture.world.viewWorkflow(fixture.workflowId))?.acceptedSignalIds).toContain(
    fixture.commandEventId('/approved'),
  );
  expect(await acceptedSignal(fixture)).toMatchObject({
    kind: WatchGateVerdictSignal,
    outcome: ActivityOutcomeKind.Done,
  });
});

it('rejects a watchGate wait with /changes', async () => {
  const fixture = await waitingIssueWorkflow(WatchGateVerdictSignal);

  await applyHumanIssueCommand(fixture, '/changes please fix the error handling');

  const workflow = await fixture.world.viewWorkflow(fixture.workflowId);
  expect(workflow?.acceptedSignalIds).toContain(
    fixture.commandEventId('/changes please fix the error handling'),
  );
  expect(await acceptedSignal(fixture)).toMatchObject({
    kind: WatchGateVerdictSignal,
    outcome: ActivityOutcomeKind.Rejected,
  });
  expect(workflow?.currentStage).toBe(stageName('implement'));
  expect(workflow?.pendingActivation?.activity).toBe(activityName('implement'));
});

it('uses a blocked human-authorized wait for a human /approved command', async () => {
  const fixture = await waitingIssueWorkflow(signalName('approved'), true);
  await fixture.world.blockWorkflow(fixture.workflowId, 'group-budget-exhausted');

  await applyHumanIssueCommand(fixture, '/approved');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'completed',
    acceptedSignalIds: [fixture.commandEventId('/approved')],
  });
  expect(await acceptedSignal(fixture)).toMatchObject({
    authority: { kind: 'human' },
  });
});

it('retries refinement on /changes and advances to implementation on /approved', async () => {
  const fixture = await twoStageIssueWorkflow();

  await fixture.world.acceptOutcome(fixture.workflowId, fixture.initialActivationId, {
    kind: ActivityOutcomeKind.Done,
  });
  await applyHumanIssueCommand(fixture, '/changes please revise the approach');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'active',
    currentStage: 'refine',
    pendingActivation: { activity: 'refine' },
  });

  const retried = await fixture.world.viewWorkflow(fixture.workflowId);
  await fixture.world.acceptOutcome(fixture.workflowId, retried!.pendingActivation!.activationId, {
    kind: ActivityOutcomeKind.Done,
  });
  await applyHumanIssueCommand(fixture, '/approved');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'active',
    currentStage: 'implement',
    pendingActivation: { activity: 'implement' },
  });
});

it('restarts a blocked agent refinement on /changes', async () => {
  const fixture = await blockedIssueWorkflow();

  await applyHumanIssueCommand(fixture, '/changes clarify the closure provenance');
  await applyHumanIssueCommand(fixture, '/changes clarify the closure provenance');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'active',
    currentStage: 'refine',
    pendingActivation: { activity: activityName('agent'), ordinal: 2 },
  });
  expect(await fixture.world.events('orchestration.operator-retry-requested')).toHaveLength(1);
});

it('restarts exactly an eligible blocked agent refinement on a plain issue reply', async () => {
  const fixture = await blockedIssueWorkflow();

  await applyHumanIssueCommand(fixture, 'The closure provenance is in the newest commit.');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'active',
    currentStage: 'refine',
    pendingActivation: { activity: activityName('agent'), ordinal: 2 },
  });
  expect(await fixture.world.events('orchestration.operator-retry-requested')).toHaveLength(1);
});

it('does not resume a blocked issue workflow from a plain reply after its work closes', async () => {
  const fixture = await blockedIssueWorkflow();

  await fixture.world.closeWork(fixture.workItemId, 'issue closed externally');
  await applyHumanIssueCommand(fixture, 'The closure provenance is in the newest commit.');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'blocked',
    pendingActivation: { activity: activityName('agent'), ordinal: 1 },
  });
  expect(await fixture.world.events('orchestration.operator-retry-requested')).toHaveLength(0);
});

it('leaves a waiting issue workflow unchanged for a plain reply', async () => {
  const fixture = await waitingIssueWorkflow(signalName('approved'));

  await applyHumanIssueCommand(fixture, 'Could you clarify the rollout timing?');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'waiting',
    waitingFor: { signalKind: signalName('approved') },
  });
  expect(await fixture.world.events('orchestration.signal-accepted')).toHaveLength(0);
});

it('does not resume a blocked stage for an unrecognized slash command', async () => {
  const fixture = await blockedIssueWorkflow();

  await applyHumanIssueCommand(fixture, '/ask Is the rollout timing final?');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'blocked',
    pendingActivation: { activity: activityName('agent'), ordinal: 1 },
  });
  expect(await fixture.world.events('orchestration.operator-retry-requested')).toHaveLength(0);
});

it('still satisfies the plain approval workflow unchanged', async () => {
  const fixture = await waitingIssueWorkflow(signalName('approved'));

  await applyHumanIssueCommand(fixture, '/approved');

  expect((await fixture.world.viewWorkflow(fixture.workflowId))?.status).not.toBe('waiting');
});

it('leaves a waiting correlated PR workflow unchanged for a plain reply', async () => {
  const fixture = await waitingIssueWorkflow(signalName('approved'));
  const pr = await fixture.world.discoverResource({
    resourceId: `resource-${'0'.repeat(25)}1` as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake-test#8' },
    capabilities: [resourceCapability('commentable'), resourceCapability('reviewable')],
  });
  await fixture.world.resources.correlate(pr.resourceId, fixture.workItemId, 'primary', {
    commandId: 'correlate-pr-feedback',
    correlationId: correlationId('pr-feedback'),
    occurredAt: fixture.world.clock.now().toISOString(),
    actor: { kind: 'system', id: 'test' },
  });

  await applyHumanPrComment(fixture, 'Please handle the null response before retrying.');

  expect(await fixture.world.viewWorkflow(fixture.workflowId)).toMatchObject({
    status: 'waiting',
    waitingFor: { signalKind: signalName('approved') },
  });
  expect(await fixture.world.events('orchestration.signal-accepted')).toHaveLength(0);
});

it('ignores Wake delivery comments on a correlated PR', async () => {
  const fixture = await waitingIssueWorkflow(signalName('approved'));
  const pr = await fixture.world.discoverResource({
    resourceId: `resource-${'0'.repeat(25)}1` as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake-test#8' },
    capabilities: [resourceCapability('commentable'), resourceCapability('reviewable')],
  });
  await fixture.world.resources.correlate(pr.resourceId, fixture.workItemId, 'primary', {
    commandId: 'correlate-pr-delivery',
    correlationId: correlationId('pr-delivery'),
    occurredAt: fixture.world.clock.now().toISOString(),
    actor: { kind: 'system', id: 'test' },
  });

  await applyHumanPrComment(fixture, '<!-- wake:agent -->\n**Wake** status update');

  expect((await fixture.world.viewWorkflow(fixture.workflowId))?.status).toBe('waiting');
  expect(await fixture.world.events('orchestration.signal-accepted')).toHaveLength(0);
});

it('accepts an explicit /approved command from a correlated PR', async () => {
  const fixture = await waitingIssueWorkflow(signalName('approved'));
  const pr = await fixture.world.discoverResource({
    resourceId: `resource-${'0'.repeat(25)}1` as never,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake-test#8' },
    capabilities: [resourceCapability('commentable'), resourceCapability('reviewable')],
  });
  await fixture.world.resources.correlate(pr.resourceId, fixture.workItemId, 'primary', {
    commandId: 'correlate-pr-approval',
    correlationId: correlationId('pr-approval'),
    occurredAt: fixture.world.clock.now().toISOString(),
    actor: { kind: 'system', id: 'test' },
  });

  await applyHumanPrComment(fixture, '/approved');

  expect((await fixture.world.viewWorkflow(fixture.workflowId))?.status).toBe('completed');
});

async function issueCommentSignals(body: string): Promise<unknown[]> {
  const acceptedSignals: unknown[] = [];

  await applyReviewSignal({
    event: issueCommentEvent(body),
    journal: {} as never,
    resources: {
      async correlations() {
        return [{ role: 'primary', workItemId: 'work-7' }];
      },
      async get() {
        return { kind: resourceKind('issue') };
      },
    } as never,
    work: {
      async get() {
        return { state: 'open', frozen: false, deleted: false };
      },
    } as never,
    lookup: {
      async resourceIdForExternalKey() {
        return 'resource-7';
      },
    } as never,
    pullRequests: undefined,
    ids: {} as never,
    adapter: GitHubAdapter,
    orchestration: {
      async listAll() {
        return [
          {
            workflowInstanceId: 'workflow-7',
            workItemId: 'work-7',
            waitingFor: { signalKind: signalName('approved') },
          },
        ];
      },
      async acceptSignal(_workflowInstanceId: unknown, signal: unknown) {
        acceptedSignals.push(signal);
      },
    } as never,
  });

  return acceptedSignals;
}

function issueCommentEvent(
  body: string,
): Extract<GitHubAdapterEvent, { eventType: typeof GitHubEventType.CommentObserved }> {
  return {
    eventId: 'github:issue-comment:atolis-hq/wake-test#7:99:2026-08-08T00:00:00Z',
    eventType: GitHubEventType.CommentObserved,
    occurredAt: '2026-08-08T00:00:00Z',
    correlationId: 'github:atolis-hq/wake-test#7',
    causationId: 'github:issue-comment:99',
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: GitHubAdapter },
    stream: { kind: 'integration', id: GitHubAdapter },
    payload: {
      reviewKind: 'issue',
      externalKey: 'atolis-hq/wake-test#7',
      body,
      revision: '2026-08-08T00:00:00Z',
      actor: { id: 'a-reviewer', kind: ReviewActorKind.Human },
      raw: { id: 99 },
    },
    globalPosition: 0,
    ingestedAt: '2026-08-08T00:00:00Z',
  } as never;
}

async function waitingIssueWorkflow(
  signalKind: ReturnType<typeof signalName>,
  humanAuthority = false,
) {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
      z
        .object({
          kind: z.literal(ActivityOutcomeKind.Waiting),
          data: z.object({ signalKind: z.string(), intentEventId: z.string() }).passthrough(),
        })
        .strict(),
    ]),
    outcomeKinds: [ActivityOutcomeKind.Done, ActivityOutcomeKind.Waiting],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: ActivityOutcomeKind.Done } as const;
      },
    },
  });
  world.configureWorkflow('issue-command', {
    stages: {
      implement: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
    },
  });
  const work = await world.createWork({ objective: 'human command signal' });
  const resource = await world.discoverResource({
    resourceId: `resource-${'0'.repeat(26)}` as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake-test#7' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate-resource',
    correlationId: correlationId('issue-command'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system', id: 'test' },
  });
  const started = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('issue-command'),
  });
  await world.acceptOutcome(started.workflowInstanceId, started.pendingActivation!.activationId, {
    kind: ActivityOutcomeKind.Waiting,
    data: { signalKind: 'initial-human-wait', intentEventId: 'initial-human-wait' },
  });
  await world.waitForSignal(started.workflowInstanceId, {
    signalKind,
    ...(humanAuthority ? { from: [{ kind: 'human' as const }] } : {}),
    resume: { kind: TransitionTargetKind.Complete },
    onRejectResume: { kind: TransitionTargetKind.Stage, stage: stageName('implement') },
  });
  return {
    world,
    workflowId: started.workflowInstanceId,
    workItemId: work.workItemId,
    commandEventId: (body: string) => `github:issue-comment:atolis-hq/wake-test#7:99:${body}`,
  };
}

async function twoStageIssueWorkflow() {
  const world = new TestWorld();
  for (const name of ['refine', 'implement']) {
    world.registerActivity({
      name: activityName(name),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
      ]),
      outcomeKinds: [ActivityOutcomeKind.Done],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: ActivityOutcomeKind.Done } as const;
        },
      },
    });
  }
  world.configureWorkflow('issue-command-two-stage', {
    stages: {
      refine: { activity: 'refine', with: {}, on: { done: { then: 'implement' } } },
      implement: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
    },
  });
  const work = await world.createWork({ objective: 'human command signal' });
  const resource = await world.discoverResource({
    resourceId: `resource-${'0'.repeat(26)}` as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake-test#7' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate-resource',
    correlationId: correlationId('issue-command'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system', id: 'test' },
  });
  const started = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('issue-command-two-stage'),
  });
  return {
    world,
    workflowId: started.workflowInstanceId,
    workItemId: work.workItemId,
    initialActivationId: started.pendingActivation!.activationId,
    commandEventId: (body: string) => `github:issue-comment:atolis-hq/wake-test#7:99:${body}`,
  };
}

async function blockedIssueWorkflow() {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('agent'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z
      .object({ kind: z.enum([ActivityOutcomeKind.Done, ActivityOutcomeKind.Blocked]) })
      .strict(),
    outcomeKinds: [ActivityOutcomeKind.Done, ActivityOutcomeKind.Blocked],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: ActivityOutcomeKind.Done } as const;
      },
    },
  });
  world.configureWorkflow('blocked-issue-command', {
    stages: {
      refine: { activity: 'agent', with: {}, on: { done: { then: 'done' } } },
    },
  });
  const work = await world.createWork({ objective: 'blocked human command' });
  const resource = await world.discoverResource({
    resourceId: `resource-${'0'.repeat(25)}2` as never,
    kind: resourceKind('issue'),
    externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake-test#7' },
    capabilities: [resourceCapability('commentable')],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate-blocked-resource',
    correlationId: correlationId('blocked-issue-command'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system', id: 'test' },
  });
  const started = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('blocked-issue-command'),
  });
  await world.acceptOutcome(started.workflowInstanceId, started.pendingActivation!.activationId, {
    kind: ActivityOutcomeKind.Blocked,
  });
  return { world, workflowId: started.workflowInstanceId, workItemId: work.workItemId };
}

async function applyHumanIssueCommand(
  fixture: {
    readonly world: TestWorld;
    readonly workflowId: string;
    readonly workItemId: string;
  },
  body: string,
): Promise<void> {
  await applyReviewSignal({
    event: {
      eventId: `github:issue-comment:atolis-hq/wake-test#7:99:${body}`,
      eventType: GitHubEventType.CommentObserved,
      occurredAt: fixture.world.clock.now().toISOString(),
      correlationId: 'github:atolis-hq/wake-test#7',
      causationId: 'github:issue-comment:99',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: GitHubAdapter },
      stream: { kind: 'integration', id: GitHubAdapter },
      payload: {
        reviewKind: 'issue',
        externalKey: 'atolis-hq/wake-test#7',
        body,
        revision: fixture.world.clock.now().toISOString(),
        actor: { id: 'a-reviewer', kind: ReviewActorKind.Human },
        raw: { id: 99 },
      },
      globalPosition: 0,
      ingestedAt: fixture.world.clock.now().toISOString(),
    } as never,
    journal: fixture.world.journal,
    resources: fixture.world.resources,
    work: fixture.world.work,
    lookup: fixture.world.resourceLookup,
    pullRequests: fixture.world.pullRequests,
    ids: fixture.world.ids,
    adapter: GitHubAdapter,
    orchestration: fixture.world.orchestration,
  });
}

async function applyHumanPrComment(
  fixture: Awaited<ReturnType<typeof waitingIssueWorkflow>>,
  body: string,
): Promise<void> {
  await applyReviewSignal({
    event: {
      eventId: `github:pr-comment:atolis-hq/wake-test#8:${body}`,
      eventType: GitHubEventType.CommentObserved,
      occurredAt: fixture.world.clock.now().toISOString(),
      correlationId: 'github:atolis-hq/wake-test#8',
      causationId: 'github:pr-comment:101',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: GitHubAdapter },
      stream: { kind: 'integration', id: GitHubAdapter },
      payload: {
        reviewKind: 'issue',
        externalKey: 'atolis-hq/wake-test#8',
        body,
        revision: fixture.world.clock.now().toISOString(),
        actor: { id: 'a-reviewer', kind: ReviewActorKind.Human },
        raw: { id: 101 },
      },
      globalPosition: 0,
      ingestedAt: fixture.world.clock.now().toISOString(),
    } as never,
    journal: fixture.world.journal,
    resources: fixture.world.resources,
    work: fixture.world.work,
    lookup: fixture.world.resourceLookup,
    pullRequests: fixture.world.pullRequests,
    ids: fixture.world.ids,
    adapter: GitHubAdapter,
    orchestration: fixture.world.orchestration,
  });
}

async function acceptedSignal(fixture: Awaited<ReturnType<typeof waitingIssueWorkflow>>) {
  const event = (await fixture.world.events('orchestration.signal-accepted')).at(-1);
  return event?.payload;
}
