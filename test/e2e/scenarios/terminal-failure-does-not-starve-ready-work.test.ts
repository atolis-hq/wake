import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import {
  createCompositionRoot,
  createOneShotRunnerAdvance,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import { DeliveryIntentEventType } from '../../../src/integrations/index.js';
import {
  EventActorKind,
  EventSourceKind,
  correlationId,
  createEventData,
} from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import { resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-CONTROL-004',
    title: 'a blocked terminal Run does not starve independently ready work on a later tick',
    given: ['one workflow whose runner failure blocks it and a second ready workflow'],
    when: ['the control plane advances again after surfacing the terminal failure'],
    then: ['the original workflow remains blocked while the ready workflow advances'],
  },
  async () => {
    const world = new TestWorld();
    let failedAttempts = 0;
    world.registerActivity({
      name: activityName('fails-once'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          failedAttempts += 1;
          if (failedAttempts === 1) throw new Error('runner exited 1');
          return { kind: 'done' };
        },
      },
    });
    world.registerActivity({
      name: activityName('succeeds'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' };
        },
      },
    });
    world.configureWorkflow('fails-once', {
      stages: {
        run: {
          activity: 'fails-once',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    world.configureWorkflow('succeeds', {
      stages: {
        run: {
          activity: 'succeeds',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    const failedWork = await world.createWork({ objective: 'fail once' });
    const readyWork = await world.createWork({ objective: 'advance independently' });
    const failed = await world.startWorkflow({
      workItemId: failedWork.workItemId,
      workflowName: workflowName('fails-once'),
    });
    const ready = await world.startWorkflow({
      workItemId: readyWork.workItemId,
      workflowName: workflowName('succeeds'),
    });

    await expect(world.advance()).resolves.toMatchObject({
      kind: 'blocked',
      workflowInstanceId: failed.workflowInstanceId,
      reason: 'runner exited 1',
    });
    expect((await world.viewRuns())[0]).toMatchObject({ status: 'failed' });
    await expect(world.advance()).resolves.toMatchObject({ kind: 'progressed' });
    expect((await world.viewWorkflow(failed.workflowInstanceId))?.status).toBe('blocked');
    expect((await world.viewWorkflow(ready.workflowInstanceId))?.status).toBe('completed');
    expect(await world.viewRuns()).toHaveLength(2);
  },
);

it('E2E-CONTROL-005: a held delivery cannot delay one-shot subscriber scheduling', async () => {
  const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
  const journal = new InMemoryEventJournal(clock);
  const deliveryEntered = deferred<void>();
  const releaseDelivery = deferred<void>();
  const subscriberDispatched = deferred<void>();
  const trace: string[] = [];
  const runtime = await createCompositionRoot('C:/wake-low-latency', {
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: {
        default: 'ready',
        workflows: {
          ready: {
            stages: {
              run: {
                activity: 'agent',
                with: { prompt: 'ready work' },
                on: { done: { then: 'done' } },
              },
            },
          },
        },
      },
      controlPlane: {},
      integrations: { fake: { enabled: true, provider: 'fake' } },
      surfaces: {},
    }),
    journal,
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
    clock,
    decorateRunner(runner) {
      return {
        async start(request, signal) {
          trace.push('subscriber-dispatched-ready-activation');
          subscriberDispatched.resolve();
          return runner.start(request, signal);
        },
      };
    },
    decorateDeliveryAdapter(adapter) {
      return {
        async deliver(intent, signal) {
          trace.push('delivery-entered');
          deliveryEntered.resolve();
          await releaseDelivery.promise;
          return adapter.deliver(intent, signal);
        },
        reconcile: adapter.reconcile.bind(adapter),
      };
    },
  });
  try {
    const resource = await runtime.resources.discover(
      {
        resourceId: resId('slow-delivery'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'slow-delivery' },
        capabilities: [],
      },
      commandContext(clock, 'slow-delivery-resource'),
    );
    await journal.appendToStream({ kind: 'resource', id: resource.resourceId }, 1, [
      createEventData({
        eventId: 'slow-delivery-intent',
        eventType: DeliveryIntentEventType.StatusPublishRequested,
        occurredAt: clock.now().toISOString(),
        correlationId: 'slow-delivery-intent',
        causationId: 'slow-delivery-intent',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: { kind: 'resource', id: resource.resourceId },
        payload: {
          workflowInstanceId: 'workflow-slow-delivery',
          activationId: 'activation-slow-delivery',
          resourceId: resource.resourceId,
          body: 'hold this actual delivery stage',
        },
      }),
    ]);
    const item = await runtime.work.create(
      { workItemId: workId('slow-delivery'), objective: 'unrelated ready work' },
      commandContext(clock, 'ready-work'),
    );
    await runtime.orchestration.start(
      {
        workflowInstanceId: workflowInstanceId('workflow-ready'),
        workItemId: item.workItemId,
        workflowName: workflowName('ready'),
        orchestrationGroupId: orchestrationGroupId('group-ready'),
      },
      commandContext(clock, 'ready-start'),
    );

    const oneShot = createOneShotRunnerAdvance(runtime)({ maxProgress: 1 });
    await subscriberDispatched.promise;
    await deliveryEntered.promise;
    expect(trace).toEqual(['subscriber-dispatched-ready-activation', 'delivery-entered']);

    releaseDelivery.resolve();
    await oneShot;
  } finally {
    releaseDelivery.resolve();
  }
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function commandContext(clock: { now(): Date }, commandId: string) {
  return {
    commandId,
    correlationId: correlationId(commandId),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: 'test' },
  };
}
