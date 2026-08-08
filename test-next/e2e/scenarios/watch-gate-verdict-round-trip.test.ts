import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import {
  ExecutionEventType,
  RunRepository,
  runId,
  runStream,
} from '../../../src-next/execution/index.js';
import { AgentRunPublicationReactor } from '../../../src-next/integrations/application/agent-run-publication-reactor.js';
import { projectDeliveries } from '../../../src-next/integrations/delivery/application/delivery-projector.js';
import { translateGitHubOutbound } from '../../../src-next/integrations/github/application/outbound-translator.js';
import {
  BuiltInAdapterId,
  InboundTranslator,
  integrationStream,
} from '../../../src-next/integrations/github/index.js';
import { correlationId, createEventDraft } from '../../../src-next/kernel/index.js';
import { workflowName } from '../../../src-next/orchestration/index.js';
import { resourceKind } from '../../../src-next/resources/index.js';
import { resId } from '../../support/identities.js';
import { TestWorld } from '../support/world.js';

it('E2E-WATCH-GATE-VERDICT-001 publishes a child verdict marker that resolves its waiting parent', async () => {
  const fixture = await waitingWatchGate();
  const resource = await fixture.world.discoverResource({
    resourceId: resId('1'),
    kind: resourceKind('issue'),
    externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'owner/repo#7' },
    capabilities: [],
  });
  await fixture.world.resources.correlate(resource.resourceId, fixture.workItemId, 'primary', {
    commandId: 'correlate-github-resource',
    correlationId: correlationId('watch-gate-verdict'),
    occurredAt: fixture.world.clock.now().toISOString(),
    actor: { kind: 'operator', id: 'owner' },
  });
  const run = runId('run-watch-gate-child');
  await appendTerminalAgentRun(fixture.world, run, fixture.child.workflowInstanceId);

  await new AgentRunPublicationReactor({
    journal: fixture.world.journal,
    checkpoints: fixture.world.checkpoints,
    runs: new RunRepository(fixture.world.journal),
    resources: fixture.world.resources,
    orchestration: fixture.world.orchestration,
  }).runOnce();

  const [intent] = projectDeliveries(await fixture.world.journal.readAll(0));
  expect(intent).toBeDefined();
  const outbound = translateGitHubOutbound(resource, intent!);
  expect(outbound.body).toContain('"watchGateVerdict"');
  expect(outbound.body).toContain(`"runId": "${run}"`);
  expect(outbound.body).toContain('"outcome": "DONE"');

  await fixture.world.journal.append(integrationStream(BuiltInAdapterId.GitHub), 0, [
    createEventDraft({
      eventId: 'github:comment:watch-gate-verdict',
      eventType: 'integration.github.comment-observed',
      occurredAt: fixture.world.clock.now().toISOString(),
      correlationId: 'github:owner/repo#7',
      causationId: 'github:comment:watch-gate-verdict',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: {
        reviewKind: 'issue',
        externalKey: 'owner/repo#7',
        body: outbound.body,
        revision: fixture.world.clock.now().toISOString(),
        actor: { id: 'wake-bot', kind: 'bot' },
        raw: { id: 1 },
      },
    }),
  ]);

  await new InboundTranslator(
    fixture.world.journal,
    fixture.world.checkpoints,
    fixture.world.work,
    fixture.world.resources,
    { orchestration: fixture.world.orchestration, runs: new RunRepository(fixture.world.journal) },
  ).runOnce();

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'completed',
  );
});

async function waitingWatchGate() {
  const world = new TestWorld();
  world.registerActivity(activity('parent-work'));
  world.registerActivity(activity('pr-review'));
  world.configureWorkflow('pr-review', {
    stages: { review: { activity: 'pr-review', with: {}, on: { done: { then: 'done' } } } },
  });
  world.configureWorkflow('parent', {
    stages: {
      work: {
        activity: 'parent-work',
        with: {},
        on: { done: { then: 'done', watchGates: ['pr-review'] } },
      },
    },
    watches: [
      {
        id: 'pr-review',
        while: { stages: ['work'], statuses: ['waiting'] },
        on: { events: ['pr-review.requested'] },
        workflow: 'pr-review',
        maxPerGroup: 1,
      },
    ],
  });
  const work = await world.createWork({ objective: 'publish and return a watch verdict' });
  const parent = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('parent'),
  });
  await world.advance(work.workItemId);
  await world.triggerWatch('pr-review.requested', 'pr-review-trigger');
  const child = (await world.orchestration.listAll()).find(
    (workflow) => workflow.parentWorkflowInstanceId === parent.workflowInstanceId,
  );
  if (child === undefined) throw new Error('Expected a watch child workflow');
  return { world, parent, child, workItemId: work.workItemId };
}

async function appendTerminalAgentRun(
  world: TestWorld,
  id: ReturnType<typeof runId>,
  workflow: string,
) {
  const stream = runStream(id);
  const now = world.clock.now().toISOString();
  await world.journal.append(stream, 0, [
    createEventDraft({
      eventId: `execution:${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: now,
      correlationId: 'watch-gate-verdict',
      causationId: 'watch-gate-verdict',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        activationId: 'activation-watch-gate-child',
        activity: 'agent',
        workflowInstanceId: workflow,
        orchestrationGroupId: workflow,
        attempt: 1,
        startedAt: now,
      },
    }),
    createEventDraft({
      eventId: `execution:${id}:agent-result`,
      eventType: ExecutionEventType.RunRunnerResultReported,
      occurredAt: now,
      correlationId: 'watch-gate-verdict',
      causationId: 'watch-gate-verdict',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        transport: 'succeeded',
        agent: { outcome: 'DONE', displayBody: 'Review complete.', metadata: {} },
      },
    }),
    createEventDraft({
      eventId: `execution:${id}:succeeded`,
      eventType: ExecutionEventType.RunSucceeded,
      occurredAt: now,
      correlationId: 'watch-gate-verdict',
      causationId: 'watch-gate-verdict',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { outcome: { kind: 'done' }, finishedAt: now },
    }),
  ] as never);
}

function activity(name: string) {
  return {
    name: activityName(name),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'] as const,
    resources: [],
    executionKind: 'deterministic' as const,
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  };
}
