import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFileActivationSchedulerSerialiser } from '../../../src/bootstrap/index.js';
import {
  activationSchedulerSubscriptionConsumer,
  createActivationScheduler,
  createActivationSchedulerSubscriber,
  type ActivationScheduler,
} from '../../../src/control-plane/index.js';
import { EventActorKind, EventSourceKind, createEventDraft } from '../../../src/kernel/index.js';
import {
  DurableSubscriptionHost,
  FileCheckpointStore,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createFileSubscriptionRunSerialiser,
  createInMemorySubscriptionRunSerialiser,
} from '../../../src/persistence/index.js';

describe('ActivationSchedulerSubscriber', () => {
  it('dispatches a durable fact through distinct file-backed subscriber and scheduler locks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-scheduler-subscription-'));
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const checkpoint = new FileCheckpointStore(root);
    const startupEntered = deferred<void>();
    const startupCompleted = deferred<void>();
    const dispatched = deferred<void>();
    let pending = false;
    const workflow = {
      workflowInstanceId: 'workflow-one',
      workItemId: 'work-one',
      orchestrationGroupId: 'group-one',
      acceptedOutcomes: [],
    } as never;
    const activation = { activationId: 'activation-one' } as never;
    let schedulerPasses = 0;
    const activationScheduler = createActivationScheduler(
      {
        reconcileChildCompletions: async () => startupEntered.resolve(),
        listPendingActivations: async () => (pending ? [{ workflow, activation }] : []),
        listWaiting: async () => [],
        acceptOutcome: async () => workflow,
        markActivationStarted: async () => workflow,
      },
      {
        attempt: async () => {
          dispatched.resolve();
          return { runId: 'run-one', status: 'started' } as never;
        },
        list: async () => [],
      },
      { correlationsForWork: async () => [] } as never,
      clock,
      {
        ids: { next: () => 'command-one' } as never,
        schedulerSerialiser: createFileActivationSchedulerSerialiser(root),
      },
    );
    const scheduler: ActivationScheduler = {
      runOnce: async (options) => {
        const result = await activationScheduler.runOnce(options);
        if (schedulerPasses === 0) startupCompleted.resolve();
        schedulerPasses += 1;
        return result;
      },
    };
    const subscriber = createActivationSchedulerSubscriber(
      new DurableSubscriptionHost(journal, checkpoint, createFileSubscriptionRunSerialiser(root)),
      scheduler,
      { fallbackMs: 60_000 },
    );
    const controller = new AbortController();
    const run = subscriber.start(controller.signal);
    try {
      await startupEntered.promise;
      await startupCompleted.promise;
      pending = true;
      await appendFact(journal, clock);

      await expect(withTimeout(dispatched.promise)).resolves.toBeUndefined();
      await vi.waitFor(async () =>
        expect(await checkpoint.load(activationSchedulerSubscriptionConsumer)).toBe(1),
      );
    } finally {
      controller.abort();
      await run.done;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('excludes a subscriber scheduler pass behind an overlapping direct scheduler pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-scheduler-subscription-'));
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const directEntered = deferred<void>();
    const releaseDirect = deferred<void>();
    const subscriberAttempted = deferred<void>();
    const trace: string[] = [];
    const directScheduler = createActivationScheduler(
      schedulerDependencies(async () => {
        trace.push('direct-entered');
        directEntered.resolve();
        await releaseDirect.promise;
        trace.push('direct-released');
      }),
      emptyExecution(),
      { correlationsForWork: async () => [] } as never,
      clock,
      {
        ids: { next: () => 'command-one' } as never,
        schedulerSerialiser: createFileActivationSchedulerSerialiser(root),
      },
    );
    const subscriberScheduler = createActivationScheduler(
      schedulerDependencies(async () => {
        trace.push('subscriber-entered');
      }),
      emptyExecution(),
      { correlationsForWork: async () => [] } as never,
      clock,
      {
        ids: { next: () => 'command-two' } as never,
        schedulerSerialiser: createFileActivationSchedulerSerialiser(root),
      },
    );
    const subscriber = createActivationSchedulerSubscriber(
      {
        start: () => ({ abort: () => undefined, done: Promise.resolve() }),
        health: () => undefined,
      },
      {
        runOnce: async (options) => {
          subscriberAttempted.resolve();
          return subscriberScheduler.runOnce(options);
        },
      },
    );

    try {
      const direct = directScheduler.runOnce({ maxProgress: 1 });
      await directEntered.promise;
      const scheduledBySubscriber = subscriber.poke();
      await subscriberAttempted.promise;
      releaseDirect.resolve();
      await Promise.all([direct, scheduledBySubscriber]);

      expect(trace).toEqual(['direct-entered', 'direct-released', 'subscriber-entered']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps startup reconciliation in the supervised lifecycle after abort', async () => {
    const startup = deferred<{ readonly kind: 'no-work' }>();
    const durableStopped = deferred<void>();
    const fallbackEntered = deferred<void>();
    const fallbackStopped = deferred<void>();
    const scheduler: ActivationScheduler = { runOnce: vi.fn(() => startup.promise) };
    const subscriber = createActivationSchedulerSubscriber(
      {
        start: () => ({ abort: () => durableStopped.resolve(), done: durableStopped.promise }),
        health: () => undefined,
      },
      scheduler,
      {
        fallbackMs: 1,
        waitForFallback: async (signal) => {
          fallbackEntered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          fallbackStopped.resolve();
        },
      },
    );

    const run = subscriber.start();
    await vi.waitFor(() => expect(scheduler.runOnce).toHaveBeenCalledOnce());
    await fallbackEntered.promise;
    run.abort();
    let settled = false;
    void run.done.then(() => {
      settled = true;
    });
    await fallbackStopped.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    startup.resolve({ kind: 'no-work' });
    await run.done;
  });

  it('reports startup reconciliation failure even when an empty durable host is healthy', async () => {
    const journal = new InMemoryEventJournal({ now: () => new Date('2026-08-29T00:00:00.000Z') });
    const schedulerFailure = new Error('startup scheduler failed');
    const scheduler: ActivationScheduler = {
      runOnce: vi.fn(async () => {
        throw schedulerFailure;
      }),
    };
    const subscriber = createActivationSchedulerSubscriber(
      new DurableSubscriptionHost(
        journal,
        new InMemoryCheckpointStore(),
        createInMemorySubscriptionRunSerialiser(),
      ),
      scheduler,
      { fallbackMs: 60_000 },
    );
    const controller = new AbortController();
    const run = subscriber.start(controller.signal);

    await vi.waitFor(() =>
      expect(subscriber.health()).toMatchObject({
        consumer: activationSchedulerSubscriptionConsumer,
        status: 'degraded',
        checkpoint: 0,
        consecutiveFailures: 1,
        lastError: schedulerFailure,
      }),
    );

    controller.abort();
    await run.done;
  });

  it('counts repeated fallback reconciliation failures and clears them after recovery', async () => {
    const firstFailure = new Error('first fallback failed');
    const secondFailure = new Error('second fallback failed');
    const fallbackGates: (() => void)[] = [];
    const durableStopped = deferred<void>();
    const scheduler: ActivationScheduler = {
      runOnce: vi
        .fn<ActivationScheduler['runOnce']>()
        .mockResolvedValueOnce({ kind: 'no-work' })
        .mockRejectedValueOnce(firstFailure)
        .mockRejectedValueOnce(secondFailure)
        .mockResolvedValueOnce({ kind: 'no-work' }),
    };
    const subscriber = createActivationSchedulerSubscriber(
      {
        start: (_subscriptions, signal) => {
          signal?.addEventListener('abort', () => durableStopped.resolve(), { once: true });
          return { abort: () => durableStopped.resolve(), done: durableStopped.promise };
        },
        health: () => ({
          consumer: activationSchedulerSubscriptionConsumer,
          status: 'healthy',
          checkpoint: 0,
          consecutiveFailures: 0,
        }),
      },
      scheduler,
      {
        fallbackMs: 1,
        waitForFallback: (signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            const done = () => {
              signal.removeEventListener('abort', done);
              resolve();
            };
            fallbackGates.push(done);
            signal.addEventListener('abort', done, { once: true });
          }),
      },
    );
    const controller = new AbortController();
    const run = subscriber.start(controller.signal);

    await vi.waitFor(() => expect(fallbackGates).toHaveLength(1));
    fallbackGates.shift()!();
    await vi.waitFor(() =>
      expect(subscriber.health()).toMatchObject({
        status: 'degraded',
        consecutiveFailures: 1,
        lastError: firstFailure,
      }),
    );
    await vi.waitFor(() => expect(fallbackGates).toHaveLength(1));
    fallbackGates.shift()!();
    await vi.waitFor(() =>
      expect(subscriber.health()).toMatchObject({
        status: 'degraded',
        consecutiveFailures: 2,
        lastError: secondFailure,
      }),
    );
    await vi.waitFor(() => expect(fallbackGates).toHaveLength(1));
    fallbackGates.shift()!();
    await vi.waitFor(() =>
      expect(subscriber.health()).toMatchObject({ status: 'healthy', consecutiveFailures: 0 }),
    );

    controller.abort();
    await run.done;
  });

  it('schedules at startup and after every new journal fact, then checkpoints only after success', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const checkpoints = new InMemoryCheckpointStore();
    const scheduler: ActivationScheduler = {
      runOnce: vi.fn(async () => ({ kind: 'no-work' as const })),
    };
    const subscriber = createActivationSchedulerSubscriber(
      new DurableSubscriptionHost(journal, checkpoints, createInMemorySubscriptionRunSerialiser()),
      scheduler,
      { fallbackMs: 60_000 },
    );
    const controller = new AbortController();

    const run = subscriber.start(controller.signal);
    await vi.waitFor(() => expect(scheduler.runOnce).toHaveBeenCalledOnce());
    await journal.append({ kind: 'test', id: 'one' }, 0, [
      createEventDraft({
        eventId: 'event-one',
        eventType: 'test.fact',
        occurredAt: clock.now().toISOString(),
        correlationId: 'test',
        causationId: 'test',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: { kind: 'test', id: 'one' },
        payload: {},
      }),
    ]);

    await vi.waitFor(() => expect(scheduler.runOnce).toHaveBeenCalledTimes(2));
    await expect(checkpoints.load(activationSchedulerSubscriptionConsumer)).resolves.toBe(1);
    expect(subscriber.health()).toMatchObject({
      consumer: activationSchedulerSubscriptionConsumer,
      status: 'healthy',
      checkpoint: 1,
    });
    controller.abort();
    await run.done;
  });

  it('does not advance the durable checkpoint when scheduling fails', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const journal = new InMemoryEventJournal(clock);
    const checkpoints = new InMemoryCheckpointStore();
    await journal.append({ kind: 'test', id: 'one' }, 0, [
      createEventDraft({
        eventId: 'event-one',
        eventType: 'test.fact',
        occurredAt: clock.now().toISOString(),
        correlationId: 'test',
        causationId: 'test',
        actor: { kind: EventActorKind.System, id: 'test' },
        source: { kind: EventSourceKind.Internal, id: 'test' },
        stream: { kind: 'test', id: 'one' },
        payload: {},
      }),
    ]);
    const scheduler: ActivationScheduler = {
      runOnce: vi.fn(async () => {
        throw new Error('failed');
      }),
    };
    const subscriber = createActivationSchedulerSubscriber(
      new DurableSubscriptionHost(journal, checkpoints, createInMemorySubscriptionRunSerialiser()),
      scheduler,
      { fallbackMs: 60_000 },
    );
    const controller = new AbortController();
    const run = subscriber.start(controller.signal);

    await vi.waitFor(() => expect(subscriber.health()).toMatchObject({ status: 'degraded' }));
    await expect(checkpoints.load(activationSchedulerSubscriptionConsumer)).resolves.toBe(0);
    controller.abort();
    await run.done;
  });
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function appendFact(journal: InMemoryEventJournal, clock: { now(): Date }): Promise<void> {
  await journal.append({ kind: 'test', id: 'one' }, 0, [
    createEventDraft({
      eventId: 'event-one',
      eventType: 'test.fact',
      occurredAt: clock.now().toISOString(),
      correlationId: 'test',
      causationId: 'test',
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: EventSourceKind.Internal, id: 'test' },
      stream: { kind: 'test', id: 'one' },
      payload: {},
    }),
  ]);
}

function withTimeout<Value>(promise: Promise<Value>): Promise<Value> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Scheduler subscriber lock timed out')), 500).unref();
    }),
  ]);
}

function schedulerDependencies(reconcileChildCompletions: () => Promise<void>) {
  return {
    reconcileChildCompletions,
    listPendingActivations: async () => [],
    listWaiting: async () => [],
    acceptOutcome: async () => {
      throw new Error('No activation outcomes expected');
    },
    markActivationStarted: async () => {
      throw new Error('No activations expected');
    },
  };
}

function emptyExecution() {
  return {
    attempt: async () => {
      throw new Error('No execution attempts expected');
    },
    list: async () => [],
  };
}
