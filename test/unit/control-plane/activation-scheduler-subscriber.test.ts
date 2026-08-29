import { describe, expect, it, vi } from 'vitest';
import {
  createActivationSchedulerSubscriber,
  type ActivationScheduler,
} from '../../../src/control-plane/index.js';
import { EventActorKind, EventSourceKind, createEventDraft } from '../../../src/kernel/index.js';
import {
  DurableSubscriptionHost,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createInMemorySubscriptionRunSerialiser,
} from '../../../src/persistence/index.js';

describe('ActivationSchedulerSubscriber', () => {
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
            signal.addEventListener('abort', resolve, { once: true }),
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
    await expect(checkpoints.load('activation-scheduler')).resolves.toBe(1);
    expect(subscriber.health()).toMatchObject({
      consumer: 'activation-scheduler',
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
    await expect(checkpoints.load('activation-scheduler')).resolves.toBe(0);
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
