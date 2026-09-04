import { expect, it } from 'vitest';
import { z } from 'zod';

import { correlationId, type EventEnvelope } from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import {
  ActivityRegistry,
  activityName,
  agentActivityOutcomeKinds,
  agentActivityOutcomeSchema,
  createAgentActivity,
} from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  parseRootConfig,
  type CompositionRoot,
} from '../../../src/bootstrap/index.js';
import type { Runner, RunnerRequest } from '../../../src/execution/index.js';
import { DurableFakeDeliveryProvider } from '../../../src/integrations/fake/durable-delivery-provider.js';
import { DeliveryIntentEventType } from '../../../src/integrations/index.js';
import { type Clock } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  watchId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { resourceKind } from '../../../src/resources/index.js';
import { workProjection } from '../../../src/work/index.js';
import { resId, workId } from '../../support/identities.js';
import {
  FaultInjector,
  InjectedFaultError,
  faultInjectingCheckpoints,
  faultInjectingDeliveryAdapter,
  faultInjectingJournal,
  faultInjectingProjections,
  faultInjectingScheduleCheckpoints,
} from '../support/faults.js';

const scenario = { id: 'E2E-FAULT-001' } as const;
const clock: Clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };

it(`${scenario.id} replays or exposes every composed durable boundary without duplicate external calls`, async () => {
  expect.hasAssertions();
  await journalAppendBoundaries();
  await projectionAndCheckpointBoundaries();
  await executionAndOutcomeBoundaries();
  await deliveryBoundaries();
  await childCompletionBoundaries();
  await scheduleSlotBoundaries();
}, 30_000);

async function journalAppendBoundaries(): Promise<void> {
  for (const [index, point] of [
    'journal.appendToStream.before',
    'journal.appendToStream.after',
  ].entries()) {
    const fixture = await composed();
    const id = workId(`journal-append-${index}`);
    fixture.faults.failOnce(point);
    const create = () =>
      fixture.root.work.create({ workItemId: id, objective: point }, context(point));
    await expect(create()).rejects.toBeInstanceOf(InjectedFaultError);
    // Both windows replay the original command. The post-append window must
    // re-read the durable fact rather than relying on the failed response.
    await create();
    await tick(fixture.root);
    expect(
      (await fixture.root.journal.readAll(0)).filter(
        (event) => event.event.eventType === 'work.item-created',
      ),
    ).toHaveLength(1);
    await expectPublicWorkProjection(fixture.root, id, point);
  }
}

async function projectionAndCheckpointBoundaries(): Promise<void> {
  for (const point of [
    'projection.write.before',
    'projection.write.after',
    'checkpoint.write.before',
    'checkpoint.write.after',
  ] as const) {
    const fixture = await composed();
    await fixture.root.work.create({ workItemId: workId(point), objective: point }, context(point));
    fixture.faults.failOnce(point);
    await triggerFault(fixture.root, fixture.faults, point);
    await tick(fixture.root);
    expect(
      (await fixture.root.journal.readAll(0)).filter(
        (event) => event.event.eventType === 'work.item-created',
      ),
    ).toHaveLength(1);
    await expectPublicWorkProjection(fixture.root, workId(point), point);
  }
}

async function executionAndOutcomeBoundaries(): Promise<void> {
  let ordinal = 0;
  for (const point of [
    'run.start.before',
    'run.start.after',
    'run.result-append.before',
    'run.result-append.after',
    'workflow.outcome-acceptance.before',
    'workflow.outcome-acceptance.after',
  ] as const) {
    const fixture = await composed({ workflow: true });
    const item = await fixture.root.work.create(
      { workItemId: workId(`e${ordinal++}`), objective: point },
      context(point),
    );
    await fixture.root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId(`workflow-${point}`),
        workItemId: item.workItemId,
        workflowName: workflowName('fault-workflow'),
        orchestrationGroupId: orchestrationGroupId(`group-${point}`),
      },
      context(point),
    );
    fixture.faults.failOnce(point);
    await triggerFault(fixture.root, fixture.faults, point);
    await tick(fixture.root, 4);
    const events = await fixture.root.journal.readAll(0);
    await assertExecutionRecovery(fixture.root, point, events, fixture.runnerRequests);
  }
}

async function deliveryBoundaries(): Promise<void> {
  let ordinal = 0;
  for (const point of [
    'outbound.provider-acceptance.before',
    'outbound.provider-acceptance.after',
    'delivery.confirmation-append.before',
    'delivery.confirmation-append.after',
  ] as const) {
    const fixture = await composed({ delivery: true });
    expect(fixture.composedDeliveryAdapter, point).toBe(fixture.deliveryProvider);
    const resource = await fixture.root.resources.discover(
      {
        resourceId: resId(`d${ordinal++}`),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: point },
        capabilities: [],
      },
      context(point),
    );
    await fixture.root.journal.appendToStream({ kind: 'resource', id: resource.resourceId }, 1, [
      {
        eventId: `${point}-intent` as never,
        eventType: DeliveryIntentEventType.StatusPublishRequested,
        schemaVersion: 1,
        occurredAt: clock.now().toISOString(),
        correlationId: correlationId(point),
        causationId: point as never,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        payload: {
          workflowInstanceId: `workflow-${point}`,
          activationId: `activation-${point}`,
          resourceId: resource.resourceId,
          body: point,
        },
      },
    ]);
    fixture.faults.failOnce(point);
    await triggerFault(fixture.root, fixture.faults, point);
    await tick(fixture.root, 3);
    // This is the actual durable provider composed at the root, never a
    // decorator-owned counter. A retry cannot be mistaken for a durable effect.
    expect(fixture.deliveryProvider.deliveryCalls, point).toBe(1);
    expect(fixture.deliveryProvider.effects.size, point).toBe(1);
    if (
      point === 'outbound.provider-acceptance.after' ||
      point === 'delivery.confirmation-append.before'
    )
      expect(fixture.deliveryProvider.effects.size, point).toBe(1);
    await assertDeliveryRecovery(fixture.root, point);
  }
}

async function assertDeliveryRecovery(root: CompositionRoot, point: string): Promise<void> {
  const events = await root.journal.readAll(0);
  const confirmations = events.filter((event) => event.event.eventType === 'delivery.confirmed');
  const reconciliations = events.filter(isTerminalDeliveryConfirmation);
  if (
    point === 'outbound.provider-acceptance.after' ||
    point === 'delivery.confirmation-append.before'
  ) {
    expect(confirmations, point).toHaveLength(0);
    expect(reconciliations, point).toHaveLength(1);
    return;
  }
  expect(confirmations, point).toHaveLength(1);
  expect(reconciliations, point).toHaveLength(1);
}

async function childCompletionBoundaries(): Promise<void> {
  let ordinal = 0;
  for (const point of [
    'child.completion-consumption.before',
    'child.completion-consumption.after',
  ] as const) {
    const fixture = await composed({ child: true });
    const item = await fixture.root.work.create(
      { workItemId: workId(`c${ordinal++}`), objective: point },
      context(point),
    );
    const parent = await fixture.root.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId(`parent-${point}`),
        workItemId: item.workItemId,
        workflowName: workflowName('parent'),
        orchestrationGroupId: orchestrationGroupId(`parent-${point}`),
      },
      context(point),
    );
    await tick(fixture.root, 2);
    await fixture.root.orchestration.waitForSignal(
      parent.workflowInstanceId,
      {
        signalKind: 'orchestration.child-completed' as never,
        from: [{ kind: 'watch', watch: watchId('child') }],
      },
      context(point),
    );
    await fixture.root.journal.appendToStream({ kind: 'test', id: point }, 0, [
      {
        eventId: `${point}-trigger` as never,
        eventType: 'fault.child.requested',
        schemaVersion: 1,
        occurredAt: clock.now().toISOString(),
        correlationId: correlationId(point),
        causationId: point as never,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        payload: {},
      },
    ]);
    fixture.faults.failOnce(point);
    await triggerFault(fixture.root, fixture.faults, point);
    await tick(fixture.root, 3);
    expect(
      (await fixture.root.journal.readAll(0)).filter(
        (event) => event.event.eventType === 'orchestration.child-completion-consumed',
      ),
    ).toHaveLength(1);
    const recovered = await fixture.root.orchestration.get(parent.workflowInstanceId);
    expect(recovered?.acceptedChildCompletionIds, point).toHaveLength(1);
  }
}

async function scheduleSlotBoundaries(): Promise<void> {
  for (const point of [
    'schedule.slot-checkpoint.before',
    'schedule.slot-checkpoint.after',
  ] as const) {
    const fixture = await composed({ schedule: true });
    fixture.faults.failOnce(point);
    await expect(tick(fixture.root)).rejects.toBeInstanceOf(InjectedFaultError);
    await tick(fixture.root);
    expect(
      (await fixture.root.journal.readAll(0)).filter(
        (event) => event.event.eventType === 'work.item-created',
      ),
    ).toHaveLength(1);
    expect((await fixture.root.projections.list(workProjection.name)).length, point).toBe(1);
  }
}

async function expectPublicWorkProjection(
  root: CompositionRoot,
  id: ReturnType<typeof workId>,
  point: string,
): Promise<void> {
  const publicView = await root.work.get(id);
  const projected = await root.projections.read(workProjection.name, id);
  expect(publicView, point).not.toBeNull();
  expect(projected?.value, point).toMatchObject({
    workItemId: publicView!.workItemId,
    objective: publicView!.objective,
    state: publicView!.state,
    tags: publicView!.tags,
    autoApprovalGranted: publicView!.autoApprovalGranted,
    relatedWorkItems: publicView!.relatedWorkItems,
  });
}

async function assertExecutionRecovery(
  root: CompositionRoot,
  point: string,
  events: readonly EventEnvelope[],
  runnerRequests: readonly RunnerRequest[],
): Promise<void> {
  const runs = await root.execution.list();
  const recoveredResult = events.filter(
    (event) => event.event.eventType === 'orchestration.activity-outcome-accepted',
  );
  const durableFailure = runs.filter(
    (run) => run.status === 'failed' || run.status === 'ambiguous' || run.escalated,
  );
  // Every point finishes with either a durable recovery outcome or an explicit
  // failed/ambiguous/escalated run; a bare started run is never treated as safe.
  expect(recoveredResult.length + durableFailure.length, point).toBeGreaterThan(0);
  expect(
    runs.some((run) => run.status === 'started'),
    point,
  ).toBe(false);
  // An execution fault must not launch the same agent work twice. The request
  // is evidence from the real runner boundary and its identity is the Run that
  // recorded the outcome, not a fabricated test value.
  expect(runnerRequests, point).toHaveLength(
    point === 'run.start.before' || point === 'run.start.after' ? 0 : 1,
  );
  if (point === 'run.start.before' || point === 'run.start.after') return;
  const [request] = runnerRequests;
  expect(
    runs.some((run) => run.runId === request!.runId),
    point,
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.event.eventType === 'execution.run-runner-result-reported' &&
        event.stream.id === request!.runId,
    ),
    point,
  ).toBe(true);
  switch (point) {
    case 'run.start.before':
      // Preparation is durable before a start append, so an interruption here
      // fails that starting attempt without invoking the external runner.
      expect(
        events.filter((event) => event.event.eventType === 'execution.run-started'),
        point,
      ).toHaveLength(0);
      return;
    case 'run.start.after':
      // A durable start without a reported external identity is never replayed.
      expect(
        events.filter((event) => event.event.eventType === 'execution.run-started'),
        point,
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event.eventType === 'execution.run-failed'),
        point,
      ).toHaveLength(1);
      return;
    case 'run.result-append.before':
    case 'run.result-append.after':
      expect(
        events.filter((event) => event.event.eventType === 'execution.run-runner-result-reported'),
        point,
      ).not.toHaveLength(0);
      expect(recoveredResult, point).toHaveLength(1);
      return;
    case 'workflow.outcome-acceptance.before':
    case 'workflow.outcome-acceptance.after':
      // The only legal recovered public result is one idempotent acceptance.
      expect(recoveredResult, point).toHaveLength(1);
      return;
    default:
      throw new Error(`Unexpected execution recovery point: ${point}`);
  }
}

async function tick(root: CompositionRoot, count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const options = { maxProgress: 1 };
    await root.projectionSubscriptions.catchUpOnce();
    try {
      await root.runnerPipeline.run(options, undefined, async () => {
        await root.projectionSubscriptions.catchUpOnce();
        await root.activationSchedulerSubscriber.poke(options);
      });
    } finally {
      await root.projectionSubscriptions.catchUpOnce();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function isTerminalDeliveryConfirmation(event: EventEnvelope): boolean {
  return (
    event.event.eventType === 'delivery.confirmed' ||
    (event.event.eventType === 'delivery.reconciled' &&
      (event.event.payload as { readonly result?: string }).result === 'confirmed')
  );
}

async function triggerFault(
  root: CompositionRoot,
  faults: FaultInjector,
  point: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await tick(root);
    } catch (error) {
      expect(error).toBeInstanceOf(InjectedFaultError);
    }
    if (!faults.isArmed(point)) return;
  }
  throw new Error(
    `The armed composed fault ${point} was never reached by runnerPipeline; events=${(await root.journal.readAll(0)).map((event) => event.event.eventType).join(',')}`,
  );
}

function context(commandId: string) {
  return {
    commandId,
    correlationId: correlationId(commandId),
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
}

async function composed(
  options: { workflow?: boolean; delivery?: boolean; child?: boolean; schedule?: boolean } = {},
) {
  const faults = new FaultInjector();
  const deliveryProvider = new DurableFakeDeliveryProvider();
  let composedDeliveryAdapter: DurableFakeDeliveryProvider | undefined;
  const runnerRequests: RunnerRequest[] = [];
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('fault-workflow'),
    inputSchema: z.object({ prompt: z.string() }).strict(),
    outcomeSchema: agentActivityOutcomeSchema,
    outcomeKinds: agentActivityOutcomeKinds,
    resources: [],
    executionKind: 'agent',
    handler: createAgentActivity(),
  });
  for (const name of ['parent', 'child', 'scheduled'])
    activities.register({
      name: activityName(name),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' } as const;
        },
      },
    });
  const workflows: Record<string, unknown> = {};
  if (options.workflow)
    workflows['fault-workflow'] = {
      stages: {
        run: {
          activity: 'fault-workflow',
          with: { prompt: 'fault matrix' },
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    };
  if (options.child) {
    workflows.parent = {
      stages: {
        run: {
          activity: 'parent',
          with: {},
          on: { done: { then: 'await-human' } },
          requiresApproval: false,
        },
      },
      watches: [
        {
          id: 'child',
          while: { stages: ['run'], statuses: ['waiting'] },
          on: { events: ['fault.child.requested'] },
          workflow: 'child',
          maxPerGroup: 1,
        },
      ],
    };
    workflows.child = {
      stages: {
        run: {
          activity: 'child',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    };
  }
  if (options.schedule)
    workflows.scheduled = {
      stages: {
        run: {
          activity: 'scheduled',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    };
  const defaultWorkflow = options.schedule
    ? 'scheduled'
    : options.child
      ? 'parent'
      : 'fault-workflow';
  const config = parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      ...(Object.keys(workflows).length === 0 ? {} : { default: defaultWorkflow }),
      workflows,
    },
    controlPlane: options.schedule
      ? {
          schedules: [
            { id: 'hourly', workflow: 'scheduled', cron: '* * * * *', objective: 'scheduled' },
          ],
        }
      : {},
    integrations: options.delivery ? { fake: { enabled: true, provider: 'fake' } } : {},
    surfaces: {},
  });
  const root = await createCompositionRoot('C:/wake-home', {
    config,
    activities,
    clock,
    journal: new InMemoryEventJournal(clock),
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
    decorateJournal: (base) => faultInjectingJournal(base, faults),
    decorateProjections: (base) => faultInjectingProjections(base, faults),
    decorateCheckpoints: (base) => faultInjectingCheckpoints(base, faults),
    decorateRunner: (runner: Runner) => spyRunner(runner, runnerRequests),
    fakeDeliveryProvider: deliveryProvider,
    scheduleCheckpoints: faultInjectingScheduleCheckpoints(
      {
        async load() {
          return '2026-08-10T00:00:00.000Z';
        },
        async save() {},
      },
      faults,
    ),
    decorateDeliveryAdapter: (adapter) => {
      composedDeliveryAdapter = adapter as DurableFakeDeliveryProvider;
      return faultInjectingDeliveryAdapter(adapter, faults);
    },
  });
  return {
    root,
    faults,
    deliveryProvider,
    composedDeliveryAdapter,
    runnerRequests,
  };
}

function spyRunner(runner: Runner, requests: RunnerRequest[]): Runner {
  return {
    async start(request, signal) {
      requests.push(request);
      return runner.start(request, signal);
    },
  };
}
