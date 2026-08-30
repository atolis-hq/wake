import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  ProviderPermission,
  ReviewActorKind,
  activityName,
} from '../../../src/activities/index.js';
import { EventProcessorHost } from '../../../src/eventing/index.js';
import {
  ExecutionEventType,
  RunRepository,
  runId,
  runStream,
} from '../../../src/execution/index.js';
import { AgentRunPublicationReactor } from '../../../src/integrations/application/agent-run-publication-reactor.js';
import { projectDeliveries } from '../../../src/integrations/delivery/application/delivery-projector.js';
import { translateGitHubOutbound } from '../../../src/integrations/github/application/outbound-translator.js';
import {
  BuiltInAdapterId,
  InboundTranslator,
  integrationStream,
} from '../../../src/integrations/github/index.js';
import { correlationId, createEventData } from '../../../src/kernel/index.js';
import {
  OrchestrationEventType,
  WatchGateVerdictSignal,
  signalName,
  workflowInstanceStream,
  workflowName,
} from '../../../src/orchestration/index.js';
import { createInMemoryProcessorRunSerialiser } from '../../../src/persistence/index.js';
import { resourceKind } from '../../../src/resources/index.js';
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
  await appendTerminalAgentRun(
    fixture.world,
    run,
    fixture.child.workflowInstanceId,
    fixture.child.pendingActivation!.activationId,
  );
  await fixture.world.acceptOutcome(
    fixture.child.workflowInstanceId,
    fixture.child.pendingActivation!.activationId,
    { kind: 'done' },
  );

  const publications = new AgentRunPublicationReactor({
    journal: fixture.world.journal,
    runs: new RunRepository(fixture.world.journal),
    resources: fixture.world.resources,
    orchestration: fixture.world.orchestration,
  });
  await fixture.world.process(publications.processor);

  const [intent] = projectDeliveries(await fixture.world.journal.readAll(0));
  expect(intent).toBeDefined();
  const outbound = translateGitHubOutbound(resource, intent!);
  expect(outbound.body).toContain('"watchGateVerdict"');
  expect(outbound.body).toContain(`"runId": "${run}"`);
  expect(outbound.body).toContain('"outcome": "DONE"');

  await fixture.world.journal.appendToStream(integrationStream(BuiltInAdapterId.GitHub), 0, [
    createEventData({
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

  const translator = new InboundTranslator(
    fixture.world.journal,
    fixture.world.work,
    fixture.world.resources,
    {
      orchestration: fixture.world.orchestration,
      runs: new RunRepository(fixture.world.journal),
      lookup: fixture.world.resourceLookup,
    },
  );
  await processInbound(translator, fixture.world);

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'completed',
  );
});

it('supersedes a queued watch child when human approval leaves its gate', async () => {
  const fixture = await waitingWatchGate();

  await fixture.world.acceptSignal(fixture.parent.workflowInstanceId, {
    kind: WatchGateVerdictSignal,
    actorId: 'owner',
    actorDecision: { authorized: true, evidenceId: 'github-comment-1' },
    providerEventId: 'github-comment-1',
    authority: { kind: 'human' },
  });

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'completed',
  );
  expect((await fixture.world.viewWorkflow(fixture.child.workflowInstanceId))?.status).toBe(
    'superseded',
  );
});

it('E2E-WATCH-GATE-EXTEND-001 accepts an authorized GitHub /extend command after gate exhaustion', async () => {
  const fixture = await waitingWatchGate();
  const resource = await fixture.world.discoverResource({
    resourceId: resId('extend-1'),
    kind: resourceKind('issue'),
    externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'owner/repo#17' },
    capabilities: [],
  });
  await fixture.world.resources.correlate(resource.resourceId, fixture.workItemId, 'primary', {
    commandId: 'correlate-extend-resource',
    correlationId: correlationId('watch-gate-extend'),
    occurredAt: fixture.world.clock.now().toISOString(),
    actor: { kind: 'operator', id: 'owner' },
  });
  await fixture.world.triggerWatch('pr-review.requested', 'pr-review-trigger-exhausted');
  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'blocked',
  );
  expect(
    (await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.waitingFor,
  ).toMatchObject({
    signalKind: 'orchestration.watch-gate-verdict',
  });

  await fixture.world.journal.appendToStream(integrationStream(BuiltInAdapterId.GitHub), 0, [
    createEventData({
      eventId: 'github:comment:watch-gate-extend',
      eventType: 'integration.github.comment-observed',
      occurredAt: fixture.world.clock.now().toISOString(),
      correlationId: 'github:owner/repo#17',
      causationId: 'github:comment:watch-gate-extend',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: {
        reviewKind: 'issue',
        externalKey: 'owner/repo#17',
        body: '/extend',
        revision: fixture.world.clock.now().toISOString(),
        actor: { id: 'maintainer', kind: ReviewActorKind.Human },
        authorization: {
          source: 'provider-permission',
          permission: ProviderPermission.Write,
        },
        raw: { id: 17 },
      },
    }),
  ]);

  const translator = new InboundTranslator(
    fixture.world.journal,
    fixture.world.work,
    fixture.world.resources,
    {
      orchestration: fixture.world.orchestration,
      runs: new RunRepository(fixture.world.journal),
      lookup: fixture.world.resourceLookup,
    },
  );
  await processInbound(translator, fixture.world);

  expect(await fixture.world.events('integration.github.inbound-translation-retried')).toHaveLength(
    0,
  );
  expect(await fixture.world.events('orchestration.group-budget-granted')).toHaveLength(1);
  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'waiting',
  );
  expect(
    (await fixture.world.orchestration.listAll()).filter(
      (workflow) => workflow.parentWorkflowInstanceId === fixture.parent.workflowInstanceId,
    ),
  ).toHaveLength(2);
});

it('cancels an active watch-child run when human approval leaves its gate', async () => {
  const fixture = await waitingWatchGate();
  const activeRun = runId('run-active-watch-child');
  await appendStartedRun(
    fixture.world,
    activeRun,
    fixture.child.workflowInstanceId,
    fixture.child.pendingActivation!.activationId,
  );

  await fixture.world.acceptSignal(fixture.parent.workflowInstanceId, {
    kind: WatchGateVerdictSignal,
    actorId: 'owner',
    actorDecision: { authorized: true, evidenceId: 'github-comment-2' },
    providerEventId: 'github-comment-2',
    authority: { kind: 'human' },
  });

  expect((await fixture.world.viewWorkflow(fixture.child.workflowInstanceId))?.status).toBe(
    'superseded',
  );
  expect((await fixture.world.viewRuns()).find((run) => run.runId === activeRun)?.status).toBe(
    'cancelled',
  );
});

it('supersedes a watch child when another valid transition replaces its gate', async () => {
  const fixture = await waitingWatchGate();

  await fixture.world.waitForSignal(fixture.parent.workflowInstanceId, {
    signalKind: signalName('operator-recheck'),
  });

  expect((await fixture.world.viewWorkflow(fixture.child.workflowInstanceId))?.status).toBe(
    'superseded',
  );
});

it('supersedes a recovered child whose parent has already left its gate before dispatch', async () => {
  const fixture = await waitingWatchGate();
  const stream = workflowInstanceStream(fixture.parent.workflowInstanceId);
  const events = await fixture.world.journal.readStream(stream);
  await fixture.world.journal.appendToStream(stream, events.length, [
    createEventData({
      eventId: 'recovered-parent-signal',
      eventType: OrchestrationEventType.SignalAccepted,
      occurredAt: fixture.world.clock.now().toISOString(),
      correlationId: 'watch-gate-verdict',
      causationId: 'recovered-parent-signal',
      actor: { kind: 'operator', id: 'owner' },
      source: { kind: 'internal', id: 'recovery' },
      stream,
      payload: {
        kind: WatchGateVerdictSignal,
        actorId: 'owner',
        actorDecision: { authorized: true, evidenceId: 'github-comment-3' },
        providerEventId: 'github-comment-3',
        authority: { kind: 'human' },
      },
    }),
  ]);

  expect((await fixture.world.viewWorkflow(fixture.parent.workflowInstanceId))?.status).toBe(
    'active',
  );
  expect((await fixture.world.viewWorkflow(fixture.child.workflowInstanceId))?.watchId).toBe(
    'pr-review',
  );
  expect(typeof fixture.world.orchestration.validateActivationDispatch).toBe('function');
  expect(
    await fixture.world.orchestration.validateActivationDispatch(fixture.child.workflowInstanceId, {
      commandId: 'validate-recovered-child',
      correlationId: correlationId('watch-gate-verdict'),
      occurredAt: fixture.world.clock.now().toISOString(),
      actor: { kind: 'system', id: 'test' },
    }),
  ).toBe(false);
  expect((await fixture.world.viewWorkflow(fixture.child.workflowInstanceId))?.status).toBe(
    'superseded',
  );
  expect((await fixture.world.viewWorkflow(fixture.child.workflowInstanceId))?.status).toBe(
    'superseded',
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
  await world.advanceUntilSettled(work.workItemId);
  await world.triggerWatch('pr-review.requested', 'pr-review-trigger');
  const child = (await world.orchestration.listAll()).find(
    (workflow) => workflow.parentWorkflowInstanceId === parent.workflowInstanceId,
  );
  if (child === undefined) throw new Error('Expected a watch child workflow');
  return { world, parent, child, workItemId: work.workItemId };
}

function processInbound(translator: InboundTranslator, world: TestWorld) {
  return new EventProcessorHost(
    world.journal,
    world.checkpoints,
    createInMemoryProcessorRunSerialiser(),
  ).runOnce(translator.processor);
}

async function appendTerminalAgentRun(
  world: TestWorld,
  id: ReturnType<typeof runId>,
  workflow: string,
  activationId: string,
) {
  const stream = runStream(id);
  const now = world.clock.now().toISOString();
  await world.journal.appendToStream(stream, 0, [
    createEventData({
      eventId: `execution:${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: now,
      correlationId: 'watch-gate-verdict',
      causationId: 'watch-gate-verdict',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        activationId,
        activity: 'agent',
        workflowInstanceId: workflow,
        orchestrationGroupId: workflow,
        attempt: 1,
        startedAt: now,
      },
    }),
    createEventData({
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
    createEventData({
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

async function appendStartedRun(
  world: TestWorld,
  id: ReturnType<typeof runId>,
  workflow: string,
  activationId: string,
) {
  const stream = runStream(id);
  const now = world.clock.now().toISOString();
  await world.journal.appendToStream(stream, 0, [
    createEventData({
      eventId: `execution:${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: now,
      correlationId: 'watch-gate-verdict',
      causationId: 'watch-gate-verdict',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        activationId,
        activity: 'agent',
        workflowInstanceId: workflow,
        orchestrationGroupId: workflow,
        attempt: 1,
        startedAt: now,
      },
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
