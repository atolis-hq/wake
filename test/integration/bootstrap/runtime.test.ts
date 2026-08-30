import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityRegistry,
  BuiltInActivityName,
  activationId,
  activityOrchestrationGroupId,
  activityWorkflowInstanceId,
} from '../../../src/activities/index.js';
import {
  analyticsProjection,
  createCompositionRoot,
  createSurfaceApplications,
  parseRootConfig,
} from '../../../src/bootstrap/index.js';
import {
  ControlStreamKind,
  activationSchedulerSubscriptionConsumer,
} from '../../../src/control-plane/index.js';
import type { ProcessorRunSerialiser } from '../../../src/eventing/index.js';
import {
  ExecutionEventType,
  TranscriptStore,
  runId,
  runStream,
} from '../../../src/execution/index.js';
import { GitHubAdapter } from '../../../src/integrations/github/contracts/vocabulary.js';
import {
  issueCommentObservation,
  issueObservation,
} from '../../../src/integrations/github/infrastructure/issue-source.js';
import { DeliveryIntentEventType } from '../../../src/integrations/index.js';
import type { CheckpointStore, EventJournal, ProjectionStore } from '../../../src/kernel/index.js';
import {
  EventActorKind,
  EventSourceKind,
  causationId,
  correlationId,
  createEventData,
  eventId,
} from '../../../src/kernel/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  workflowInstanceId,
  workflowInstanceStream,
  workflowName,
} from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import {
  ResourceCorrelationRole,
  resourceCapability,
  resourceKind,
} from '../../../src/resources/index.js';
import { toWorkItemKey } from '../../../src/surfaces/index.js';
import { resId, workId } from '../../support/identities.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
});

describe('target composition root', () => {
  it('always composes the activation scheduler as a durable subscriber', async () => {
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: parseRootConfig({
        schemaVersion: 1,
        execution: {
          agentRunners: { fake: { kind: 'fake' } },
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
        },
        orchestration: { workflows: {} },
        controlPlane: {},
        integrations: {},
        surfaces: {},
      }),
      journal: new InMemoryEventJournal({ now: () => new Date('2026-08-29T00:00:00.000Z') }),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
    });

    expect(runtime.activationSchedulerSubscriber).toBeDefined();
  });

  it('exposes projection subscriptions without a legacy projection runner facade', async () => {
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: parseRootConfig({
        schemaVersion: 1,
        execution: {
          agentRunners: { fake: { kind: 'fake' } },
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
        },
        orchestration: { workflows: {} },
        controlPlane: {},
        integrations: {},
        surfaces: {},
      }),
      journal: new InMemoryEventJournal({ now: () => new Date('2026-08-29T00:00:00.000Z') }),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
    });

    expect(runtime.projectionSubscriptions).toBeDefined();
    expect(runtime).not.toHaveProperty('projectionRunner');
  });

  it('hosts the activation scheduler processor through the injected processor serialiser', async () => {
    const root = await fixtureRoot();
    const serialisedConsumers: string[] = [];
    const serialise: ProcessorRunSerialiser = async (consumer, _signal, operation) => {
      serialisedConsumers.push(consumer);
      return operation();
    };
    const runtime = await createCompositionRoot(root, {
      config: rootConfig(),
      journal: new InMemoryEventJournal({ now: () => new Date('2026-08-29T00:00:00.000Z') }),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      subscriptionRunSerialiser: serialise,
    });
    const controller = new AbortController();
    const run = startProcessorRuntime(runtime, controller.signal);
    try {
      await runtime.work.create(
        { workItemId: workId('shared-scheduler-serialiser'), objective: 'serialise scheduler' },
        commandContext({ now: () => new Date('2026-08-29T00:00:00.000Z') }, 'shared-serialiser'),
      );

      await vi.waitFor(() =>
        expect(serialisedConsumers).toContain(activationSchedulerSubscriptionConsumer),
      );
    } finally {
      controller.abort();
      await run.done;
    }
  });

  it('starts a production-composed fake runner from a conversation resume through the subscriber', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const firstRunnerStarted = deferred<void>();
    const resumedRunnerStarted = deferred<void>();
    const trace: string[] = [];
    let runnerStarts = 0;
    const root = await fixtureRoot();
    const runtime = await createCompositionRoot(root, {
      config: subscriberConversationRootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
      decorateRunner(runner) {
        return {
          async start(request, signal) {
            runnerStarts += 1;
            trace.push(`runner:${runnerStarts}`);
            if (runnerStarts === 1) firstRunnerStarted.resolve();
            if (runnerStarts === 2) resumedRunnerStarted.resolve();
            return runner.start(request, signal);
          },
        };
      },
    });
    const run = startProcessorRuntime(runtime);
    const item = await runtime.work.create(
      { workItemId: workId('conversation-latency'), objective: 'resume blocked agent work' },
      commandContext(clock, 'conversation-latency-work'),
    );
    const workflow = workflowInstanceId('workflow-conversation-latency');
    try {
      await runtime.orchestration.start(
        {
          workflowInstanceId: workflow,
          workItemId: item.workItemId,
          workflowName: workflowName('conversation-latency'),
          orchestrationGroupId: orchestrationGroupId('group-conversation-latency'),
        },
        commandContext(clock, 'conversation-latency-start'),
      );

      await firstRunnerStarted.promise;
      await waitForJournalEvent(
        journal,
        0,
        (event) =>
          event.eventType === OrchestrationEventType.InstanceBlocked &&
          event.stream.id === workflow,
      );
      trace.push('blocked');
      // The resident projection subscriptions normally maintain this read
      // model; this test advances them explicitly before invoking the API.
      await runtime.projectionSubscriptions.catchUpOnce();

      const message = (
        await createSurfaceApplications(runtime, { now: () => clock.now().toISOString() })
      ).api.work.message;
      if (message === undefined)
        throw new Error('Expected enabled conversation message application');
      await message(toWorkItemKey(item.workItemId), {
        idempotencyKey: 'conversation-latency-message',
        body: 'Please continue using this correction.',
      });
      trace.push('message-recorded');

      const facts = await journal.readStream(workflowInstanceStream(workflow));
      expect(facts.map((event) => event.eventType)).toContain(
        OrchestrationEventType.OperatorRetryRequested,
      );
      expect(
        facts.filter((event) => event.eventType === OrchestrationEventType.ActivityRequested),
      ).toHaveLength(2);
      trace.push('retry-and-activity-durable');

      await resumedRunnerStarted.promise;
      expect(runnerStarts).toBe(2);
      expect(trace).toEqual([
        'runner:1',
        'blocked',
        'message-recorded',
        'retry-and-activity-durable',
        'runner:2',
      ]);
    } finally {
      run.abort();
      await run.done;
    }
  });

  it('reconsiders released capacity through the subscriber and starts the pending activation once', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const firstCompletion = deferred<void>();
    const firstRunnerStarted = deferred<void>();
    const secondRunnerStarted = deferred<void>();
    const trace: string[] = [];
    let runnerStarts = 0;
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: subscriberCapacityRootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
      decorateRunner(runner) {
        return {
          async start(request, signal) {
            const execution = await runner.start(request, signal);
            runnerStarts += 1;
            trace.push(`runner:${runnerStarts}`);
            if (runnerStarts === 1) {
              firstRunnerStarted.resolve();
              return { ...execution, result: firstCompletion.promise.then(() => execution.result) };
            }
            if (runnerStarts === 2) secondRunnerStarted.resolve();
            return execution;
          },
        };
      },
    });
    const run = startProcessorRuntime(runtime);
    try {
      await startComposedWorkflow(runtime, clock, 'capacity-first');
      await firstRunnerStarted.promise;
      await startComposedWorkflow(runtime, clock, 'capacity-second');
      trace.push('pending-work-recorded');

      firstCompletion.resolve();
      trace.push('capacity-released');
      await secondRunnerStarted.promise;

      expect(runnerStarts).toBe(2);
      expect(trace).toEqual(['runner:1', 'pending-work-recorded', 'capacity-released', 'runner:2']);
    } finally {
      run.abort();
      await run.done;
    }
  });

  it('reads a pre-restart runner pause from durable facts before stale projections can schedule it', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const firstRuntime = await createCompositionRoot('C:/wake-home', {
      config: subscriberCapacityRootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });
    await firstRuntime.runnerControls.pause('fake', 'pause-before-restart');

    const staleProjections = new InMemoryProjectionStore();
    let runnerStarts = 0;
    const restarted = await createCompositionRoot('C:/wake-home', {
      config: subscriberCapacityRootConfig(),
      journal,
      projections: staleProjections,
      checkpoints: new InMemoryCheckpointStore(),
      clock,
      decorateRunner(runner) {
        return {
          async start(request, signal) {
            runnerStarts += 1;
            return runner.start(request, signal);
          },
        };
      },
    });
    await startComposedWorkflow(restarted, clock, 'paused-after-restart');
    // Do not run projection subscriptions: the scheduler reads the durable
    // control stream without waiting for read-model catch-up.
    await expect(staleProjections.read(ControlStreamKind.Global, 'global')).resolves.toBeNull();

    await restarted.activationSchedulerSubscriber.poke();
    expect(runnerStarts).toBe(0);

    await restarted.runnerControls.unpause('fake', 'resume-after-restart');
    await restarted.activationSchedulerSubscriber.poke();
    expect(runnerStarts).toBe(1);
  });

  it('resumes the composed subscriber from its durable checkpoint after restart', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const root = await fixtureRoot();
    const firstCheckpoint = deferred<void>();
    const secondCheckpoint = deferred<void>();
    const saves: number[] = [];
    let restarted = false;
    const decorateCheckpoints = (base: CheckpointStore): CheckpointStore => ({
      load: base.load.bind(base),
      async save(consumer, position) {
        await base.save(consumer, position);
        if (consumer !== activationSchedulerSubscriptionConsumer) return;
        saves.push(position);
        if (!restarted) firstCheckpoint.resolve();
        else secondCheckpoint.resolve();
      },
      reset: base.reset.bind(base),
    });
    const first = await createCompositionRoot(root, {
      config: subscriberRestartRootConfig(),
      clock,
      decorateCheckpoints,
    });
    const firstRun = startProcessorRuntime(first);
    try {
      await startRestartWorkflow(first, clock, 'before-restart');
      await firstCheckpoint.promise;
    } finally {
      firstRun.abort();
      await firstRun.done;
    }
    const checkpointBeforeRestart = await first.checkpoints.load(
      activationSchedulerSubscriptionConsumer,
    );
    if (checkpointBeforeRestart === undefined || checkpointBeforeRestart < 1)
      throw new Error('Expected the file-backed subscriber checkpoint before restart');

    await startRestartWorkflow(first, clock, 'after-restart');
    restarted = true;
    const secondRunnerStarted = deferred<void>();
    let restartedRunnerStarts = 0;

    const restartedRoot = await createCompositionRoot(root, {
      config: subscriberRestartRootConfig(),
      clock,
      decorateCheckpoints,
      decorateRunner(runner) {
        return {
          async start(request, signal) {
            restartedRunnerStarts += 1;
            secondRunnerStarted.resolve();
            return runner.start(request, signal);
          },
        };
      },
    });
    const restartedRun = startProcessorRuntime(restartedRoot);
    try {
      await secondRunnerStarted.promise;
      await secondCheckpoint.promise;
      expect(restartedRunnerStarts).toBe(1);
      await expect(
        restartedRoot.checkpoints.load(activationSchedulerSubscriptionConsumer),
      ).resolves.toBeGreaterThan(checkpointBeforeRestart);
      expect(saves.some((position) => position > checkpointBeforeRestart)).toBe(true);
    } finally {
      restartedRun.abort();
      await restartedRun.done;
    }
  });

  it('recovers durable started Runs through the live advance composition', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const id = runId('run-restart-recovery');
    await journal.appendToStream(runStream(id), 0, [
      createEventData({
        eventId: 'run-restart-recovery:started',
        eventType: ExecutionEventType.RunStarted,
        occurredAt: clock.now().toISOString(),
        correlationId: 'run-restart-recovery',
        causationId: 'run-restart-recovery',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: runStream(id),
        payload: {
          activationId: activationId('activation-restart-recovery'),
          activity: BuiltInActivityName.Agent,
          workflowInstanceId: activityWorkflowInstanceId('workflow-restart-recovery'),
          orchestrationGroupId: activityOrchestrationGroupId('group-restart-recovery'),
          attempt: 1,
          startedAt: clock.now().toISOString(),
        },
      }),
    ]);
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });

    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });

    await expect(runtime.execution.list()).resolves.toMatchObject([
      {
        runId: id,
        status: 'failed',
        failure: { message: 'External execution was never reported' },
      },
    ]);
  });

  it('routes composed journal writes through an optional integration decorator', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const writes: string[] = [];
    const decoratedJournal: EventJournal = {
      async appendToStream(stream, expectedSequence, events) {
        writes.push(`${stream.kind}:${stream.id}`);
        return journal.appendToStream(stream, expectedSequence, events);
      },
      readStream: journal.readStream.bind(journal),
      readAll: journal.readAll.bind(journal),
      readLatest: journal.readLatest?.bind(journal),
      latestGlobalPosition: journal.latestGlobalPosition.bind(journal),
      waitForEventsAfter: journal.waitForEventsAfter.bind(journal),
      changeSignal: journal.changeSignal,
    };
    const decorator = vi.fn((base: EventJournal) => {
      expect(base).toBe(journal);
      return decoratedJournal;
    });
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      decorateJournal: decorator,
    });

    await runtime.work.create(
      { workItemId: workId('decorated-journal'), objective: 'prove integration decoration' },
      {
        commandId: 'decorated-journal',
        correlationId: correlationId('decorated-journal'),
        occurredAt: clock.now().toISOString(),
        actor: { kind: 'system', id: 'test' },
      },
    );

    expect(decorator).toHaveBeenCalledExactlyOnceWith(journal);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^work-item:/);
  });

  it('routes projection writes through the decorated projection port', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const projections = new InMemoryProjectionStore();
    let writes = 0;
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections,
      checkpoints: new InMemoryCheckpointStore(),
      decorateProjections: (base): ProjectionStore => ({
        read: base.read.bind(base),
        async write(projection) {
          writes += 1;
          await base.write(projection);
        },
        list: base.list.bind(base),
        clear: base.clear.bind(base),
      }),
    });

    await runtime.work.create(
      { workItemId: workId('decorated-projections'), objective: 'prove projection decoration' },
      commandContext(clock, 'decorated-projections'),
    );
    await runtime.projectionSubscriptions.catchUpOnce();

    expect(writes).toBeGreaterThan(0);
  });

  it('routes projection checkpoints through the decorated checkpoint port', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const checkpoints = new InMemoryCheckpointStore();
    let saves = 0;
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: rootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints,
      decorateCheckpoints: (base): CheckpointStore => ({
        load: base.load.bind(base),
        async save(consumer, position) {
          saves += 1;
          await base.save(consumer, position);
        },
        reset: base.reset.bind(base),
      }),
    });

    await runtime.work.create(
      { workItemId: workId('decorated-checkpoints'), objective: 'prove checkpoint decoration' },
      commandContext(clock, 'decorated-checkpoints'),
    );
    await runtime.projectionSubscriptions.catchUpOnce();

    expect(saves).toBeGreaterThan(0);
  });

  it('routes schedule slots through the supplied schedule checkpoint store', async () => {
    const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
    const saves: string[] = [];
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: scheduledRootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      scheduleCheckpoints: {
        async load() {
          return '2026-08-10T00:00:00.000Z';
        },
        async save(_scheduleId, slot) {
          saves.push(slot);
        },
      },
      clock,
    });

    await runtime.runnerPipeline.run({ maxProgress: 1 }, new AbortController().signal);

    expect(saves).toEqual(['2026-08-10T00:01:00.000Z']);
  });

  it.each([
    [
      'CLI',
      async (runtime: Awaited<ReturnType<typeof createCompositionRoot>>) => {
        const applications = await createSurfaceApplications(runtime);
        await applications.cli.tick.run({ maxAdvances: 1, maxRuns: 1, maxDurationMs: 1_000 });
      },
    ],
    [
      'API',
      async (runtime: Awaited<ReturnType<typeof createCompositionRoot>>) => {
        const applications = await createSurfaceApplications(runtime);
        await applications.api.controlPlane.tick?.({ idempotencyKey: 'due-schedule-api-tick' });
      },
    ],
  ])(
    'creates and dispatches a due schedule through a subscriber-mode one-shot %s tick',
    async (_surface, tick) => {
      const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
      let checkpoint = '2026-08-10T00:00:00.000Z';
      const runtime = await createCompositionRoot('C:/wake-home', {
        config: subscriberScheduledRootConfig(),
        journal: new InMemoryEventJournal(clock),
        projections: new InMemoryProjectionStore(),
        checkpoints: new InMemoryCheckpointStore(),
        scheduleCheckpoints: {
          async load() {
            return checkpoint;
          },
          async save(_scheduleId, slot) {
            checkpoint = slot;
          },
        },
        clock,
      });

      await tick(runtime);

      expect(await runtime.execution.list()).toHaveLength(1);
    },
  );

  it('pauses the composed runner pipeline for maintenance and resumes it after a healthy update clears the lease', async () => {
    const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
    const saves: string[] = [];
    const root = await fixtureRoot();
    const runtime = await createCompositionRoot(root, {
      config: scheduledRootConfig(),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      scheduleCheckpoints: {
        async load() {
          return '2026-08-10T00:00:00.000Z';
        },
        async save(_scheduleId, slot) {
          saves.push(slot);
        },
      },
      clock,
    });

    await runtime.maintenance.acquire('v2');
    await expect(runtime.runnerPipeline.run({ maxProgress: 1 })).resolves.toEqual({
      kind: 'paused',
    });
    expect(saves).toEqual([]);

    await runtime.maintenance.clear();
    await runtime.runnerPipeline.run({ maxProgress: 1 });
    expect(saves).toEqual(['2026-08-10T00:01:00.000Z']);
  });

  it('does not poll or translate provider intake during maintenance, then resumes intake after the lease clears', async () => {
    const root = await fixtureRoot();
    const clock = { now: () => new Date('2026-08-10T00:01:30.000Z') };
    const runtime = await createCompositionRoot(root, {
      config: parseRootConfig({
        schemaVersion: 1,
        work: {},
        resources: {},
        execution: {
          agentRunners: { fake: { kind: 'fake' } },
          runnerPools: { standard: ['fake'] },
          defaultRunnerPool: 'standard',
        },
        orchestration: { workflows: {} },
        controlPlane: {},
        integrations: {
          fake: {
            enabled: true,
            provider: 'fake',
            events: [
              {
                key: 'maintenance-intake',
                title: 'must wait for update completion',
                eligible: false,
              },
            ],
          },
        },
        surfaces: {},
      }),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });

    await runtime.maintenance.acquire('v2');
    await expect(runtime.intakePipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: false,
    });
    expect(await runtime.journal.readAll(0)).toEqual([]);

    await runtime.maintenance.clear();
    await expect(runtime.intakePipeline.run(new AbortController().signal)).resolves.toEqual({
      processed: true,
    });
    expect(await runtime.journal.readAll(0)).not.toEqual([]);
  });

  it('routes composed delivery through the decorated provider adapter', async () => {
    const clock = { now: () => new Date('2026-08-10T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    let deliveries = 0;
    const runtime = await createCompositionRoot('C:/wake-home', {
      config: fakeProviderRootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      decorateDeliveryAdapter: (adapter) => ({
        async deliver(intent, signal) {
          deliveries += 1;
          return adapter.deliver(intent, signal);
        },
        reconcile: adapter.reconcile.bind(adapter),
      }),
    });
    const resource = await runtime.resources.discover(
      {
        resourceId: resId('decorated-delivery'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'delivery-1' },
        capabilities: [],
      },
      commandContext(clock, 'decorated-delivery'),
    );
    await journal.appendToStream({ kind: 'resource', id: resource.resourceId }, 1, [
      {
        eventId: eventId('decorated-delivery-intent'),
        eventType: DeliveryIntentEventType.StatusPublishRequested,
        schemaVersion: 1,
        occurredAt: clock.now().toISOString(),
        correlationId: correlationId('decorated-delivery'),
        causationId: causationId('decorated-delivery'),
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: { kind: 'resource', id: resource.resourceId },
        payload: {
          workflowInstanceId: 'workflow-decorated-delivery',
          activationId: 'activation-decorated-delivery',
          resourceId: resource.resourceId,
          body: 'decorated delivery',
        },
      },
    ]);
    await runtime.projectionSubscriptions.catchUpOnce();

    await runtime.delivery.deliverNext(new AbortController().signal);

    expect(deliveries).toBe(1);
  });

  it('delivers from its targeted projection while an unrelated projection is blocked and the scheduler advances', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const projections = new BlockingNamespaceProjectionStore(analyticsProjection.name);
    let deliveries = 0;
    const runtime = await createCompositionRoot('C:/wake-targeted-delivery', {
      config: fakeProviderRootConfig(),
      journal,
      projections,
      checkpoints: new InMemoryCheckpointStore(),
      clock,
      decorateDeliveryAdapter: (adapter) => ({
        async deliver(intent, signal) {
          deliveries += 1;
          return adapter.deliver(intent, signal);
        },
        reconcile: adapter.reconcile.bind(adapter),
      }),
    });
    const resource = await runtime.resources.discover(
      {
        resourceId: resId('targeted-delivery'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'targeted-delivery' },
        capabilities: [],
      },
      commandContext(clock, 'targeted-delivery-resource'),
    );
    const blockedProjection = runtime.projectionSubscriptions.catchUp(analyticsProjection);
    await projections.blockedWriteStarted.promise;
    const subscriber = startProcessorRuntime(runtime);
    try {
      await journal.appendToStream({ kind: 'resource', id: resource.resourceId }, 1, [
        createEventData({
          eventId: 'targeted-delivery-intent',
          eventType: DeliveryIntentEventType.StatusPublishRequested,
          occurredAt: clock.now().toISOString(),
          correlationId: 'targeted-delivery-intent',
          causationId: 'targeted-delivery-intent',
          actor: { kind: EventActorKind.System, id: 'test' },
          source: { kind: EventSourceKind.Internal, id: 'test' },
          stream: { kind: 'resource', id: resource.resourceId },
          payload: {
            workflowInstanceId: 'workflow-targeted-delivery',
            activationId: 'activation-targeted-delivery',
            resourceId: resource.resourceId,
            body: 'deliver despite unrelated projection latency',
          },
        }),
      ]);
      await vi.waitFor(async () => {
        expect(await runtime.checkpoints.load(activationSchedulerSubscriptionConsumer)).toBe(2);
      });

      await runtime.runnerPipeline.run({ maxProgress: 1 }, new AbortController().signal);

      expect(deliveries).toBe(1);
    } finally {
      subscriber.abort();
      projections.releaseBlockedWrite();
      await Promise.all([subscriber.done, blockedProjection]);
    }
  });

  it('injects only domain-owned config and central persistence ports', async () => {
    const config = parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: { workflows: {} },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    });
    const clock = { now: () => new Date('2026-07-31T00:00:00.000Z') };
    const runtime = await createCompositionRoot('C:/wake-home', {
      config,
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      activities: new ActivityRegistry(),
    });

    expect(runtime.config.execution.defaultRunnerPool).toBe('standard');
    expect(runtime.paths.dataRoot).toContain('.wake');
    expect(runtime.projectionSubscriptions).toBeDefined();
    expect(runtime.work).toBeDefined();
    expect(runtime.resources).toBeDefined();
    expect(runtime.orchestration).toBeDefined();
    expect(runtime.execution).toBeDefined();
  });

  it('only creates transcript artifacts for agent executions when capture is enabled', async () => {
    const disabledRoot = await fixtureRoot();
    const disabled = await createTranscriptRuntime(disabledRoot, false);

    await executeComposedAgent(disabled.runtime);

    await expect(readdir(disabled.runtime.paths.transcriptsRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const enabledRoot = await fixtureRoot();
    const enabled = await createTranscriptRuntime(enabledRoot, true);

    await executeComposedAgent(enabled.runtime);

    const workItemDirectory = join(enabled.runtime.paths.transcriptsRoot, transcriptWorkItemId);
    const [group] = await readdir(workItemDirectory);
    if (group === undefined) throw new Error('Expected a captured transcript group');
    const artifacts = await readdir(join(workItemDirectory, group));
    const promptFile = artifacts.find((file) => file.endsWith('.prompt.txt'));
    const responseFile = artifacts.find((file) => file.endsWith('.response.txt'));
    if (promptFile === undefined || responseFile === undefined)
      throw new Error('Expected prompt and response transcript artifacts');

    expect(await readFile(join(workItemDirectory, group, promptFile), 'utf8')).toBe(
      enabled.requests[0]?.prompt,
    );
    expect(await readFile(join(workItemDirectory, group, responseFile), 'utf8')).toContain(
      '"DONE"',
    );
  });

  it('exposes the composed transcript store when capture is enabled', async () => {
    const root = await fixtureRoot();
    const { runtime } = await createTranscriptRuntime(root, true);

    expect(runtime.transcriptStore).toBeDefined();
    expect(runtime.transcriptStore).toBeInstanceOf(TranscriptStore);
  });

  it('reads captured content through a real composed API root', async () => {
    const root = await fixtureRoot();
    const { runtime } = await createTranscriptRuntime(root, true);
    const store = runtime.transcriptStore;
    if (store === undefined) throw new Error('Expected composed transcript store');
    await store.capturePrompt({
      workItemId: 'work-transcript',
      runId: 'run-transcript',
      cli: 'fake',
      timestamp: '2026-08-12T10:00:00.000Z',
      text: 'captured input',
    });
    await store.captureResponse({
      workItemId: 'work-transcript',
      runId: 'run-transcript',
      cli: 'fake',
      timestamp: '2026-08-12T10:00:01.000Z',
      text: 'captured output',
    });
    await runtime.projections.write({
      namespace: 'execution',
      key: 'run-transcript',
      lastGlobalPosition: 0,
      value: {
        view: {
          runId: 'run-transcript',
          workflowInstanceId: 'workflow-transcript',
          startedAt: '2026-08-12T10:00:00.000Z',
        },
      },
    });
    await runtime.projections.write({
      namespace: 'orchestration',
      key: 'workflow-transcript',
      lastGlobalPosition: 0,
      value: { view: { workItemId: 'work-transcript' } },
    });

    await expect(
      (await createSurfaceApplications(runtime)).api.execution.transcript?.('run-transcript'),
    ).resolves.toMatchObject({
      data: { available: true, entries: [{ text: 'captured input' }, { text: 'captured output' }] },
    });
  });

  it('reads the full durable resumed-session transcript from a run deep link', async () => {
    const root = await fixtureRoot();
    const { runtime } = await createTranscriptRuntime(root, true);
    const store = runtime.transcriptStore;
    if (store === undefined) throw new Error('Expected composed transcript store');
    for (const [runId, timestamp, text] of [
      ['run-session-first', '2026-08-12T10:00:00.000Z', 'first prompt'],
      ['run-session-second', '2026-08-12T10:01:00.000Z', 'second prompt'],
    ] as const) {
      await store.capturePrompt({
        workItemId: 'work-session',
        runId,
        cli: 'fake',
        timestamp,
        text,
      });
      await store.captureResponse({
        workItemId: 'work-session',
        runId,
        cli: 'fake',
        sessionId: 'resumed-session',
        timestamp: new Date(Date.parse(timestamp) + 1).toISOString(),
        text: `${text} response`,
      });
      await runtime.projections.write({
        namespace: 'execution',
        key: runId,
        lastGlobalPosition: 0,
        value: { view: { runId, workflowInstanceId: 'workflow-session', startedAt: timestamp } },
      });
    }
    await runtime.projections.write({
      namespace: 'orchestration',
      key: 'workflow-session',
      lastGlobalPosition: 0,
      value: { view: { workItemId: 'work-session' } },
    });

    await expect(
      (await createSurfaceApplications(runtime)).api.execution.transcript?.('run-session-second'),
    ).resolves.toMatchObject({
      data: {
        runId: 'run-session-second',
        available: true,
        entries: [
          { runId: 'run-session-first', text: 'first prompt' },
          { runId: 'run-session-first', text: 'first prompt response' },
          { runId: 'run-session-second', text: 'second prompt' },
          { runId: 'run-session-second', text: 'second prompt response' },
        ],
      },
    });
  });

  it('marks transcripts after reclaiming a closed then deleted workspace without writing journal events', async () => {
    const root = await fixtureRoot();
    let now = new Date('2026-08-12T10:00:00.000Z');
    const clock = { now: () => now };
    const journal = new InMemoryEventJournal(clock);
    const runtime = await createCompositionRoot(root, {
      config: transcriptRetentionConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });
    expect(runtime.config.transcripts.retentionMs).toBe(86_400_000);
    const closed = workId('transcript-retention-closed');
    const open = workId('transcript-retention-open');
    await runtime.work.create(
      { workItemId: closed, objective: 'close me' },
      commandContext(clock, 'create-closed'),
    );
    await runtime.work.close(closed, 'complete', commandContext(clock, 'close-work'));
    await runtime.work.delete(closed, commandContext(clock, 'delete-closed'));
    await runtime.work.create(
      { workItemId: open, objective: 'retain me' },
      commandContext(clock, 'create-open'),
    );
    const transcripts = new TranscriptStore(runtime.paths.transcriptsRoot);
    await transcripts.capturePrompt({
      workItemId: closed,
      runId: 'run-closed',
      cli: 'fake',
      timestamp: clock.now().toISOString(),
      text: 'closed',
    });
    await transcripts.capturePrompt({
      workItemId: open,
      runId: 'run-open',
      cli: 'fake',
      timestamp: clock.now().toISOString(),
      text: 'open',
    });
    const closedWorkspace = await ownedWorkspace(
      runtime.paths.workspacesRoot,
      'closed-workspace',
      closed,
      'closed-run',
    );
    const openWorkspace = await ownedWorkspace(
      runtime.paths.workspacesRoot,
      'open-workspace',
      open,
      'open-run',
    );
    const eventsBefore = await journal.readAll(0);

    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });

    await expect(access(closedWorkspace.path)).rejects.toThrow();
    await expect(access(openWorkspace.path)).resolves.toBeUndefined();
    await expect(
      readFile(join(runtime.paths.transcriptsRoot, closed, '.cleaned-at'), 'utf8'),
    ).resolves.toBe(clock.now().toISOString());
    await expect(
      access(join(runtime.paths.transcriptsRoot, open, '.cleaned-at')),
    ).rejects.toThrow();
    expect(await journal.readAll(0)).toEqual(eventsBefore);

    now = new Date('2026-08-13T10:00:00.000Z');
    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });
    await expect(access(join(runtime.paths.transcriptsRoot, closed))).rejects.toThrow();
  });

  it('expires a closed work item transcript without workspace ownership and leaves open transcripts unmarked', async () => {
    const root = await fixtureRoot();
    let now = new Date('2026-08-12T10:00:00.000Z');
    const clock = { now: () => now };
    const journal = new InMemoryEventJournal(clock);
    const runtime = await createCompositionRoot(root, {
      config: transcriptRetentionConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });
    const closed = workId('retentionnoworkclosed');
    const open = workId('retentionnoworkopen');
    await runtime.work.create(
      { workItemId: closed, objective: 'close me' },
      commandContext(clock, 'create-closed'),
    );
    await runtime.work.close(closed, 'complete', commandContext(clock, 'close-closed'));
    await runtime.work.create(
      { workItemId: open, objective: 'keep me' },
      commandContext(clock, 'create-open'),
    );
    const transcripts = new TranscriptStore(runtime.paths.transcriptsRoot);
    for (const [workItemId, runId] of [
      [closed, 'run-closed'],
      [open, 'run-open'],
    ] as const)
      await transcripts.capturePrompt({
        workItemId,
        runId,
        cli: 'fake',
        timestamp: clock.now().toISOString(),
        text: workItemId,
      });
    const eventsBefore = await journal.readAll(0);

    await runtime.projectionSubscriptions.catchUpOnce();
    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });

    await expect(
      readFile(join(runtime.paths.transcriptsRoot, closed, '.cleaned-at'), 'utf8'),
    ).resolves.toBe(clock.now().toISOString());
    await expect(
      access(join(runtime.paths.transcriptsRoot, open, '.cleaned-at')),
    ).rejects.toThrow();
    expect(await journal.readAll(0)).toEqual(eventsBefore);

    now = new Date('2026-08-13T10:00:00.000Z');
    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });

    await expect(access(join(runtime.paths.transcriptsRoot, closed))).rejects.toThrow();
    await expect(access(join(runtime.paths.transcriptsRoot, open))).resolves.toBeUndefined();
    expect(await journal.readAll(0)).toEqual(eventsBefore);
  });

  it('removes transcripts immediately when a closed then deleted workspace uses zero retention', async () => {
    const root = await fixtureRoot();
    const clock = { now: () => new Date('2026-08-12T10:00:00.000Z') };
    const runtime = await createCompositionRoot(root, {
      config: transcriptRetentionConfig(0),
      journal: new InMemoryEventJournal(clock),
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });
    const closed = workId('transcript-retention-zero');
    await runtime.work.create(
      { workItemId: closed, objective: 'close me' },
      commandContext(clock, 'create-zero'),
    );
    await runtime.work.close(closed, 'complete', commandContext(clock, 'close-zero'));
    await runtime.work.delete(closed, commandContext(clock, 'delete-zero'));
    const transcripts = new TranscriptStore(runtime.paths.transcriptsRoot);
    await transcripts.capturePrompt({
      workItemId: closed,
      runId: 'run-zero',
      cli: 'fake',
      timestamp: clock.now().toISOString(),
      text: 'remove now',
    });
    await ownedWorkspace(runtime.paths.workspacesRoot, 'zero-workspace', closed, 'zero-run');

    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });

    await expect(access(join(runtime.paths.transcriptsRoot, closed))).rejects.toThrow();
  });

  it('retries zero-retention cleanup after a transient transcript filesystem failure without journal events', async () => {
    const root = await fixtureRoot();
    const clock = { now: () => new Date('2026-08-12T10:00:00.000Z') };
    let failRemoval = true;
    const transcriptStore = new TranscriptStore(join(root, '.wake', 'transcripts'), {
      async remove(path, options) {
        if (failRemoval) throw new Error('locked');
        await rm(path, options);
      },
    });
    const journal = new InMemoryEventJournal(clock);
    const runtime = await createCompositionRoot(root, {
      config: transcriptRetentionConfig(0),
      transcriptStore,
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
      clock,
    });
    const closed = workId('transcript-retention-retry');
    await runtime.work.create(
      { workItemId: closed, objective: 'close me' },
      commandContext(clock, 'create-retry'),
    );
    await runtime.work.close(closed, 'complete', commandContext(clock, 'close-retry'));
    await runtime.work.delete(closed, commandContext(clock, 'delete-retry'));
    await transcriptStore.capturePrompt({
      workItemId: closed,
      runId: 'run-retry',
      cli: 'fake',
      timestamp: clock.now().toISOString(),
      text: 'retry',
    });
    const workspace = await ownedWorkspace(
      runtime.paths.workspacesRoot,
      'retry-workspace',
      closed,
      'retry-run',
    );
    const eventsBefore = await journal.readAll(0);

    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });

    await expect(access(workspace.markerPath)).resolves.toBeUndefined();
    await expect(access(join(runtime.paths.transcriptsRoot, closed))).resolves.toBeUndefined();
    expect(await journal.readAll(0)).toEqual(eventsBefore);

    failRemoval = false;
    await runtime.activationSchedulerSubscriber.poke({ maxProgress: 1 });

    await expect(access(workspace.markerPath)).rejects.toThrow();
    await expect(access(join(runtime.paths.transcriptsRoot, closed))).rejects.toThrow();
    expect(await journal.readAll(0)).toEqual(eventsBefore);
  });

  it('supplies GitHub issue and comment history only through the untrusted agent context', async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, 'prompts', 'implement.md'),
      '---\n---\nTrusted instructions only.\nTitle: {{issueTitle}}\nBody: {{issueBody}}\n{{#each comments}}Comment: {{body}}{{/each}}',
    );
    const clock = { now: () => new Date('2026-08-08T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const runtime = await createCompositionRoot(root, {
      config: rootConfig(),
      journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: new InMemoryCheckpointStore(),
    });
    const context = {
      commandId: 'bootstrap-comment-context',
      correlationId: correlationId('bootstrap-comment-context'),
      occurredAt: clock.now().toISOString(),
      actor: { kind: 'system' as const, id: 'test' },
    };
    const item = await runtime.work.create(
      { workItemId: workId('bootstrap-comment-context'), objective: 'use reviewer feedback' },
      context,
    );
    const resource = await runtime.resources.discover(
      {
        resourceId: 'resource-00000000000000000000000000' as never,
        kind: resourceKind('pull-request'),
        externalKey: { adapter: GitHubAdapter, key: 'atolis-hq/wake#7' },
        capabilities: [resourceCapability('commentable')],
      },
      context,
    );
    await runtime.resources.correlate(
      resource.resourceId,
      item.workItemId,
      ResourceCorrelationRole.Primary,
      context,
    );
    const issue = issueObservation({
      repository: 'atolis-hq/wake',
      issue: {
        number: 7,
        title: 'Ship comment context',
        body: 'Keep user-provided text untrusted.',
        state: 'open',
        updated_at: clock.now().toISOString(),
        user: { login: 'author', type: 'User' },
      },
    });
    await journal.appendToStream(issue.stream, 0, [issue]);
    const comment = issueCommentObservation({
      repository: 'atolis-hq/wake',
      issue: { number: 7 },
      comment: {
        id: 1,
        body: 'please add coverage',
        created_at: clock.now().toISOString(),
        updated_at: clock.now().toISOString(),
        user: { login: 'reviewer', type: 'User' },
      },
    });
    if (comment === null) throw new Error('Test comment observation was unexpectedly empty');
    await journal.appendToStream(comment.stream, 1, [comment]);
    let prompt = '';

    await runtime.activities.execute(
      {
        activationId: activationId('bootstrap-agent'),
        activity: BuiltInActivityName.Agent,
        workItemId: item.workItemId,
        workflowInstanceId: activityWorkflowInstanceId('workflow-bootstrap-agent'),
        orchestrationGroupId: activityOrchestrationGroupId('group-bootstrap-agent'),
        causationId: 'bootstrap-comment-context',
        input: { template: 'implement' },
        resources: [],
      },
      {
        signal: new AbortController().signal,
        occurredAt: clock.now().toISOString(),
        runner: {
          async start(request) {
            prompt = request.prompt;
            return { result: Promise.resolve({ transport: 'succeeded' as const, output: 'DONE' }) };
          },
        },
        async reportExternalExecution() {},
      },
    );

    expect(prompt).toMatch(
      /^Trusted instructions only\.\nTitle: Ship comment context\nBody: Keep user-provided text untrusted\.\nComment: please add coverage\n\n<wake-untrusted-data>/,
    );
    expect(prompt).toContain('"title": "Ship comment context"');
    expect(prompt).toContain('"body": "Keep user-provided text untrusted."');
    expect(prompt).toContain('"body": "please add coverage"');
  });
});

function rootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: { workflows: {} },
    controlPlane: {},
    integrations: {},
    surfaces: {},
  });
}

async function createTranscriptRuntime(root: string, enabled: boolean) {
  const requests: Array<{ readonly prompt: string }> = [];
  const runtime = await createCompositionRoot(root, {
    config: parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      transcripts: { enabled },
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: { workflows: {} },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    }),
    journal: new InMemoryEventJournal({ now: () => new Date('2026-08-12T10:00:00.000Z') }),
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
    decorateRunner(runner) {
      return {
        async start(request, signal) {
          requests.push(request);
          return runner.start(request, signal);
        },
      };
    },
  });
  return { runtime, requests };
}

async function executeComposedAgent(runtime: Awaited<ReturnType<typeof createCompositionRoot>>) {
  const activation = activationId(`transcript-${Math.random().toString(36).slice(2)}`);
  await runtime.execution.attempt(
    {
      activationId: activation,
      ordinal: 1,
      activity: BuiltInActivityName.Agent,
      input: { prompt: 'Exact composed prompt\nwith whitespace' },
      execution: undefined,
    },
    {
      workItemId: transcriptWorkItemId,
      workflowInstanceId: activityWorkflowInstanceId('workflow-transcript-capture'),
      orchestrationGroupId: activityOrchestrationGroupId('group-transcript-capture'),
      resources: [],
    },
  );
  await vi.waitFor(async () => {
    expect((await runtime.execution.list(activation))[0]?.status).toBe('succeeded');
  });
}

const transcriptWorkItemId = workId('transcript-capture');

function scheduledRootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'scheduled',
      workflows: {
        scheduled: {
          stages: {
            start: {
              activity: 'agent',
              with: { template: 'scheduled' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {
      schedules: [
        { id: 'hourly', workflow: 'scheduled', cron: '* * * * *', objective: 'Scheduled work' },
      ],
    },
    integrations: {},
    surfaces: {},
  });
}

function subscriberScheduledRootConfig() {
  return scheduledRootConfig();
}

function subscriberConversationRootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'conversation-latency',
      workflows: {
        'conversation-latency': {
          stages: {
            implement: {
              activity: 'agent',
              with: { prompt: '[fake:blocked]' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {},
    integrations: {},
    surfaces: { api: { conversationMessages: { enabled: true } } },
  });
}

function subscriberCapacityRootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'capacity',
      workflows: {
        capacity: {
          stages: {
            implement: {
              activity: 'agent',
              with: { prompt: 'complete this work' },
              on: { done: { then: 'done' } },
              requiresApproval: false,
            },
          },
        },
      },
    },
    controlPlane: {
      maxConcurrentRuns: 1,
      maxDispatches: 1,
    },
    integrations: {},
    surfaces: {},
  });
}

function subscriberRestartRootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      default: 'restart',
      workflows: {
        restart: {
          stages: {
            run: {
              activity: 'agent',
              with: { prompt: 'restart from durable checkpoint' },
              on: { done: { then: 'done' } },
            },
          },
        },
      },
    },
    controlPlane: {},
    integrations: {},
    surfaces: {},
  });
}

function fakeProviderRootConfig() {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: { workflows: {} },
    controlPlane: {},
    integrations: { fake: { enabled: true, provider: 'fake' } },
    surfaces: {},
  });
}

function transcriptRetentionConfig(retentionMs?: number) {
  return parseRootConfig({
    schemaVersion: 1,
    work: {},
    resources: {},
    transcripts: retentionMs === undefined ? { enabled: true } : { enabled: true, retentionMs },
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: { workflows: {} },
    controlPlane: {},
    integrations: {},
    surfaces: {},
  });
}

async function ownedWorkspace(
  root: string,
  workspaceId: string,
  workItemId: string,
  runId: string,
) {
  const path = join(root, workspaceId);
  const markerPath = join(root, '.wake-workspace-ownership', `${workspaceId}.json`);
  await mkdir(path, { recursive: true });
  await mkdir(join(root, '.wake-workspace-ownership'), { recursive: true });
  await writeFile(
    markerPath,
    JSON.stringify({
      runId,
      workItemId,
      repositoryResourceId: 'resource-00000000000000000000000000',
      mode: 'read-only',
      workspaceId,
      path,
    }),
  );
  return { path, markerPath };
}

function commandContext(clock: { now(): Date }, commandId: string) {
  return {
    commandId,
    correlationId: correlationId(commandId),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: 'test' },
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-bootstrap-runtime-'));
  roots.push(root);
  await mkdir(join(root, 'prompts'));
  return root;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function startProcessorRuntime(
  root: Awaited<ReturnType<typeof createCompositionRoot>>,
  signal?: AbortSignal,
) {
  const processors = root.processorRuntime.start(signal);
  const reconciliation = root.activationSchedulerSubscriber.start(signal);
  return {
    abort() {
      processors.abort();
      reconciliation.abort();
    },
    done: Promise.all([processors.done, reconciliation.done]).then(() => undefined),
  };
}

class BlockingNamespaceProjectionStore extends InMemoryProjectionStore {
  readonly blockedWriteStarted = deferred<void>();
  private readonly release = deferred<void>();

  constructor(private readonly blockedNamespace: string) {
    super();
  }

  override async write<Value>(projection: {
    readonly namespace: string;
    readonly key: string;
    readonly lastGlobalPosition: number;
    readonly value: Value;
  }): Promise<void> {
    if (projection.namespace === this.blockedNamespace) {
      this.blockedWriteStarted.resolve();
      await this.release.promise;
    }
    await super.write(projection);
  }

  releaseBlockedWrite(): void {
    this.release.resolve();
  }
}

async function startComposedWorkflow(
  runtime: Awaited<ReturnType<typeof createCompositionRoot>>,
  clock: { now(): Date },
  id: string,
): Promise<void> {
  const item = await runtime.work.create(
    { workItemId: workId(id), objective: `complete ${id}` },
    commandContext(clock, `${id}-work`),
  );
  await runtime.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId(`workflow-${id}`),
      workItemId: item.workItemId,
      workflowName: workflowName('capacity'),
      orchestrationGroupId: orchestrationGroupId(`group-${id}`),
    },
    commandContext(clock, `${id}-start`),
  );
}

async function startRestartWorkflow(
  runtime: Awaited<ReturnType<typeof createCompositionRoot>>,
  clock: { now(): Date },
  id: string,
): Promise<void> {
  const item = await runtime.work.create(
    { workItemId: workId(`restart-${id}`), objective: `restart ${id}` },
    commandContext(clock, `${id}-work`),
  );
  await runtime.orchestration.start(
    {
      workflowInstanceId: workflowInstanceId(`workflow-restart-${id}`),
      workItemId: item.workItemId,
      workflowName: workflowName('restart'),
      orchestrationGroupId: orchestrationGroupId(`group-restart-${id}`),
    },
    commandContext(clock, `${id}-start`),
  );
}

async function waitForJournalEvent(
  journal: EventJournal,
  after: number,
  predicate: (event: Awaited<ReturnType<EventJournal['readAll']>>[number]) => boolean,
): Promise<void> {
  let position = after;
  while (true) {
    const events = await journal.readAll(position);
    const matched = events.find(predicate);
    if (matched !== undefined) return;
    position = events.at(-1)?.globalPosition ?? position;
    await journal.waitForEventsAfter(position, new AbortController().signal, 30_000);
  }
}
