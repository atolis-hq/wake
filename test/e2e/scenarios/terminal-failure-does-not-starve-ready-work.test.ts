import { expect, it } from 'vitest';
import { z } from 'zod';
import { activationId, activityName } from '../../../src/activities/index.js';
import {
  createActivationScheduler,
  createActivationSchedulerSubscriber,
  createRunnerPipeline,
  type ActivationScheduler,
} from '../../../src/control-plane/index.js';
import { EventActorKind, EventSourceKind, createEventDraft } from '../../../src/kernel/index.js';
import { workflowName } from '../../../src/orchestration/index.js';
import {
  DurableSubscriptionHost,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createInMemorySubscriptionRunSerialiser,
} from '../../../src/persistence/index.js';
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

it('E2E-CONTROL-005: a blocked legacy reactor cannot delay unrelated subscriber scheduling', async () => {
  const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
  const journal = new InMemoryEventJournal(clock);
  const legacyPublicationEntered = deferred<void>();
  const releaseLegacyPublication = deferred<void>();
  const subscriberDispatched = deferred<void>();
  const trace: string[] = [];
  let pending = false;
  const scheduler: ActivationScheduler = createActivationScheduler(
    {
      reconcileChildCompletions: async () => undefined,
      listPendingActivations: async () =>
        pending
          ? [
              {
                workflow: {
                  workflowInstanceId: 'workflow-ready' as never,
                  workItemId: 'work-ready' as never,
                  orchestrationGroupId: 'group-ready' as never,
                },
                activation: {
                  activationId: activationId('activation-ready'),
                  ordinal: 1,
                  activity: activityName('ready'),
                  input: {},
                  execution: undefined,
                  status: 'pending',
                },
              },
            ]
          : [],
      listWaiting: async () => [],
      markActivationStarted: async () => undefined,
      acceptOutcome: async () => {
        throw new Error('Ready activation remains in flight');
      },
    },
    {
      async attempt() {
        trace.push('subscriber-dispatched-ready-activation');
        subscriberDispatched.resolve();
        return { runId: 'run-ready', status: 'started' } as never;
      },
      list: async () => [],
    },
    { correlationsForWork: async () => [], get: async () => null } as never,
    clock,
    { ids: { next: () => 'command-ready' } as never },
  );
  const subscriber = createActivationSchedulerSubscriber(
    new DurableSubscriptionHost(
      journal,
      new InMemoryCheckpointStore(),
      createInMemorySubscriptionRunSerialiser(),
    ),
    scheduler,
    { fallbackMs: 60_000 },
  );
  const pipeline = createRunnerPipeline({
    catchUpProjections: async () => undefined,
    runSchedules: async () => undefined,
    react: async () => undefined,
    advance: async () => ({ kind: 'no-work' }),
    inlineActivationScheduling: false,
    publishAgentRuns: async () => {
      trace.push('legacy-publication-entered');
      legacyPublicationEntered.resolve();
      await releaseLegacyPublication.promise;
    },
    deliver: async () => undefined,
  });
  const run = subscriber.start();
  try {
    const legacy = pipeline.run({ maxProgress: 1 });
    await legacyPublicationEntered.promise;
    pending = true;
    await journal.append({ kind: 'test', id: 'ready-activation' }, 0, [
      createEventDraft({
        eventId: 'ready-activation',
        eventType: 'test.ready-activation',
        occurredAt: clock.now().toISOString(),
        correlationId: 'ready-activation',
        causationId: 'ready-activation',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: { kind: 'test', id: 'ready-activation' },
        payload: {},
      }),
    ]);

    await subscriberDispatched.promise;
    expect(trace).toEqual(['legacy-publication-entered', 'subscriber-dispatched-ready-activation']);

    releaseLegacyPublication.resolve();
    await legacy;
  } finally {
    run.abort();
    await run.done;
  }
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
