import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  activityName,
  ActivityOutcomeKind,
  ReviewActorKind,
} from '../../../../src-next/activities/index.js';
import { applyReviewSignal } from '../../../../src-next/integrations/github/application/inbound-review-signals.js';
import { GitHubEventType } from '../../../../src-next/integrations/github/contracts/events.js';
import { GitHubAdapter } from '../../../../src-next/integrations/github/contracts/vocabulary.js';
import { correlationId } from '../../../../src-next/kernel/index.js';
import {
  signalName,
  stageName,
  TransitionTargetKind,
  WatchGateVerdictSignal,
  workflowName,
} from '../../../../src-next/orchestration/index.js';
import { resourceCapability, resourceKind } from '../../../../src-next/resources/index.js';
import { TestWorld } from '../../../e2e/support/world.js';

it('ignores an issue comment that is not a recognized command', async () => {
  expect(await issueCommentSignals('just a status update, not a command')).toEqual([]);
});

it('recognizes a normalized /approved issue command', async () => {
  expect(await issueCommentSignals('  /ApPrOvEd  ')).toHaveLength(1);
});

it('recognizes /changes with feedback as an issue command', async () => {
  expect(await issueCommentSignals('/changes please retry the error handling')).toHaveLength(1);
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

it('still satisfies the plain approval workflow unchanged', async () => {
  const fixture = await waitingIssueWorkflow(signalName('approved'));

  await applyHumanIssueCommand(fixture, '/approved');

  expect((await fixture.world.viewWorkflow(fixture.workflowId))?.status).not.toBe('waiting');
});

async function issueCommentSignals(body: string): Promise<unknown[]> {
  const acceptedSignals: unknown[] = [];

  await applyReviewSignal({
    event: {
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
    } as never,
    journal: {} as never,
    resources: {
      async correlations() {
        return [{ role: 'primary', workItemId: 'work-7' }];
      },
    } as never,
    work: {} as never,
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

async function waitingIssueWorkflow(signalKind: ReturnType<typeof signalName>) {
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
    onRejectResume: { kind: TransitionTargetKind.Stage, stage: stageName('implement') },
  });
  return {
    world,
    workflowId: started.workflowInstanceId,
    commandEventId: (body: string) => `github:issue-comment:atolis-hq/wake-test#7:99:${body}`,
  };
}

async function applyHumanIssueCommand(
  fixture: Awaited<ReturnType<typeof waitingIssueWorkflow>>,
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

async function acceptedSignal(fixture: Awaited<ReturnType<typeof waitingIssueWorkflow>>) {
  const event = (await fixture.world.events('orchestration.signal-accepted')).at(-1);
  return event?.payload;
}
