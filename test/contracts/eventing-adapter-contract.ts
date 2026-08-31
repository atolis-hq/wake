import {
  createEventData,
  WrongExpectedSequenceError,
  type CheckpointStore,
  type EventEnvelope,
  type EventingClock,
  type EventJournal,
  type ProcessorRunSerialiser,
  type ProcessorStateStore,
  type ProjectionStore,
  type StreamRef,
} from '@atolis-hq/eventing';
import { describe, expect, it } from 'vitest';

export interface EventingAdapterHarness {
  readonly journal: EventJournal;
  readonly checkpoints: CheckpointStore;
  readonly projections: ProjectionStore;
  readonly processorState: ProcessorStateStore;
  readonly serialiseRun: ProcessorRunSerialiser;
  readonly flatRecordCompatibility?: () => Promise<readonly EventEnvelope[]>;
  dispose(): Promise<void>;
}

export interface EventingAdapterFactory {
  create(clock: EventingClock): Promise<EventingAdapterHarness>;
}

const recordedAt = '2026-08-31T12:30:00.000Z';
const occurredAt = '2026-08-31T12:00:00.000Z';
const stream: StreamRef<'contract', 'one'> = { kind: 'contract', id: 'one' };
const otherStream: StreamRef<'contract', 'two'> = { kind: 'contract', id: 'two' };
const clock: EventingClock = { now: () => new Date(recordedAt) };

export function eventingAdapterContract(name: string, factory: EventingAdapterFactory): void {
  describe(`${name} Eventing adapter contract`, () => {
    it('preserves global and per-stream append ordering with assigned metadata', async () => {
      await usingHarness(factory, async ({ journal }) => {
        const first = await journal.appendToStream(stream, 0, [event('event-1'), event('event-2')]);
        await journal.appendToStream(otherStream, 0, [event('event-3')]);
        await journal.appendToStream(stream, 2, [event('event-4')]);

        expect(first).toEqual([
          expect.objectContaining({
            event: event('event-1'),
            stream,
            recordedAt,
            sequence: 1,
            globalPosition: 1,
          }),
          expect.objectContaining({
            event: event('event-2'),
            stream,
            recordedAt,
            sequence: 2,
            globalPosition: 2,
          }),
        ]);
        expect((await journal.readStream(stream)).map(identity)).toEqual([
          'event-1',
          'event-2',
          'event-4',
        ]);
        expect((await journal.readAll(0)).map(identity)).toEqual([
          'event-1',
          'event-2',
          'event-3',
          'event-4',
        ]);
        expect((await journal.readAll(1, 2)).map(identity)).toEqual(['event-2', 'event-3']);
        expect(await journal.latestGlobalPosition()).toBe(4);
      });
    });

    it('rejects empty and stale batches atomically without changing the tail', async () => {
      await usingHarness(factory, async ({ journal }) => {
        await expect(journal.appendToStream(stream, 0, [])).rejects.toThrow(
          'appendToStream requires at least one event',
        );
        await journal.appendToStream(stream, 0, [event('event-1'), event('event-2')]);

        await expect(
          journal.appendToStream(stream, 0, [event('event-3'), event('event-4')]),
        ).rejects.toBeInstanceOf(WrongExpectedSequenceError);

        expect((await journal.readAll(0)).map(identity)).toEqual(['event-1', 'event-2']);
        expect(await journal.latestGlobalPosition()).toBe(2);
      });
    });

    it('notifies after successful batches, ignores rejected batches, and wakes waiters', async () => {
      await usingHarness(factory, async ({ journal }) => {
        const initialRevision = journal.changeSignal.revision();
        const changeWait = journal.changeSignal.waitForChange(new AbortController().signal, 10_000);
        const eventWait = journal.waitForEventsAfter(0, new AbortController().signal, 10_000);

        await journal.appendToStream(stream, 0, [event('event-1'), event('event-2')]);
        await Promise.all([changeWait, eventWait]);

        const successfulRevision = journal.changeSignal.revision();
        expect(successfulRevision).toBeGreaterThan(initialRevision);
        await expect(journal.appendToStream(stream, 0, [event('event-3')])).rejects.toBeInstanceOf(
          WrongExpectedSequenceError,
        );
        expect(journal.changeSignal.revision()).toBe(successfulRevision);

        const controller = new AbortController();
        const abortedWait = journal.waitForEventsAfter(2, controller.signal, 10_000);
        controller.abort();
        await expect(abortedWait).resolves.toBeUndefined();
      });
    });

    it('persists monotonic consumer checkpoints and resets only the requested consumer', async () => {
      await usingHarness(factory, async ({ checkpoints }) => {
        expect(await checkpoints.load('consumer:first')).toBe(0);
        await checkpoints.save('consumer:first', 4);
        await checkpoints.save('consumer:second', 2);
        await expect(checkpoints.save('consumer:first', 3)).rejects.toThrow(/regression/i);
        expect(await checkpoints.load('consumer:first')).toBe(4);
        expect(await checkpoints.load('consumer:second')).toBe(2);

        await checkpoints.reset('consumer:first');

        expect(await checkpoints.load('consumer:first')).toBe(0);
        expect(await checkpoints.load('consumer:second')).toBe(2);
      });
    });

    it('round-trips projections without retaining caller-owned mutable values', async () => {
      await usingHarness(factory, async ({ projections }) => {
        const input = { nested: { value: 'stored' } };
        await projections.write({
          namespace: 'contract',
          key: 'one',
          lastGlobalPosition: 3,
          value: input,
        });
        await projections.write({
          namespace: 'other',
          key: 'one',
          lastGlobalPosition: 1,
          value: { nested: { value: 'other' } },
        });
        input.nested.value = 'writer mutation';

        const read = await projections.read<{ nested: { value: string } }>('contract', 'one');
        expect(read).toEqual({
          namespace: 'contract',
          key: 'one',
          lastGlobalPosition: 3,
          value: { nested: { value: 'stored' } },
        });
        read!.value.nested.value = 'reader mutation';
        await expect(projections.read('contract', 'one')).resolves.toMatchObject({
          value: { nested: { value: 'stored' } },
        });
        await expect(projections.list('contract')).resolves.toHaveLength(1);

        await projections.clear('contract');

        await expect(projections.read('contract', 'one')).resolves.toBeNull();
        await expect(projections.read('other', 'one')).resolves.not.toBeNull();
      });
    });

    it('clears rebuildable projections without clearing processor-owned state', async () => {
      await usingHarness(factory, async ({ projections, processorState }) => {
        await projections.write({
          namespace: 'contract',
          key: 'one',
          lastGlobalPosition: 3,
          value: { value: 'projection' },
        });
        await processorState.write({
          consumer: 'consumer:projection-rebuild',
          key: 'pending',
          value: { eventIds: ['event-1'] },
        });
        await projections.clear();

        await expect(projections.read('contract', 'one')).resolves.toBeNull();
        await expect(
          processorState.read('consumer:projection-rebuild', 'pending'),
        ).resolves.toEqual({
          consumer: 'consumer:projection-rebuild',
          key: 'pending',
          value: { eventIds: ['event-1'] },
        });
      });
    });

    it('persists, clones, isolates, and deletes processor-owned state', async () => {
      await usingHarness(factory, async ({ processorState }) => {
        const input = { events: [{ id: 'event-1' }] };
        await processorState.write({ consumer: 'consumer:first', key: 'pending', value: input });
        await processorState.write({ consumer: 'consumer:first', key: 'other', value: { n: 2 } });
        await processorState.write({
          consumer: 'consumer:second',
          key: 'pending',
          value: { n: 3 },
        });
        input.events[0]!.id = 'writer mutation';

        const read = await processorState.read<{ events: { id: string }[] }>(
          'consumer:first',
          'pending',
        );
        expect(read).toMatchObject({ value: { events: [{ id: 'event-1' }] } });
        read!.value.events[0]!.id = 'reader mutation';
        await expect(processorState.read('consumer:first', 'pending')).resolves.toMatchObject({
          value: { events: [{ id: 'event-1' }] },
        });

        await processorState.delete('consumer:first', 'pending');

        await expect(processorState.read('consumer:first', 'pending')).resolves.toBeNull();
        await expect(processorState.read('consumer:first', 'other')).resolves.not.toBeNull();
        await expect(processorState.read('consumer:second', 'pending')).resolves.not.toBeNull();
      });
    });

    it('serialises equal consumers in request order', async () => {
      await usingHarness(factory, async ({ serialiseRun }) => {
        const firstStarted = deferred<void>();
        const releaseFirst = deferred<void>();
        const order: string[] = [];
        const first = serialiseRun('consumer', new AbortController().signal, async () => {
          order.push('first:start');
          firstStarted.resolve();
          await releaseFirst.promise;
          order.push('first:end');
          return 'first';
        });
        await firstStarted.promise;
        const second = serialiseRun('consumer', new AbortController().signal, async () => {
          order.push('second');
          return 'second';
        });
        await Promise.resolve();
        expect(order).toEqual(['first:start']);

        releaseFirst.resolve();

        await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
        expect(order).toEqual(['first:start', 'first:end', 'second']);
      });
    });

    it('recovers its consumer queue after rejection and rejects aborted work before entry', async () => {
      await usingHarness(factory, async ({ serialiseRun }) => {
        await expect(
          serialiseRun('consumer', new AbortController().signal, async () => {
            throw new Error('operation failed');
          }),
        ).rejects.toThrow('operation failed');
        await expect(
          serialiseRun('consumer', new AbortController().signal, async () => 'recovered'),
        ).resolves.toBe('recovered');

        const controller = new AbortController();
        controller.abort();
        let entered = false;
        await expect(
          serialiseRun('consumer', controller.signal, async () => {
            entered = true;
          }),
        ).rejects.toThrow('Processor run aborted');
        expect(entered).toBe(false);
      });
    });

    it('reads the established flat event record when the adapter supports that format', async () => {
      await usingHarness(factory, async (harness) => {
        if (harness.flatRecordCompatibility === undefined) return;

        const events = await harness.flatRecordCompatibility();

        expect(events).toEqual([
          {
            event: {
              eventId: 'flat-event-1',
              eventType: 'contract.created',
              schemaVersion: 1,
              occurredAt,
              correlationId: 'correlation-1',
              causationId: 'causation-1',
              actor: { kind: 'system', id: 'contract' },
              source: { kind: 'internal', id: 'contract' },
              payload: { value: 1 },
            },
            stream,
            recordedAt,
            sequence: 1,
            globalPosition: 1,
          },
        ]);
      });
    });
  });
}

async function usingHarness(
  factory: EventingAdapterFactory,
  test: (harness: EventingAdapterHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory.create(clock);
  try {
    await test(harness);
  } finally {
    await harness.dispose();
  }
}

function event(eventId: string) {
  return createEventData({
    eventId,
    eventType: 'contract.created',
    occurredAt,
    correlationId: 'correlation-1',
    causationId: 'causation-1',
    actor: { kind: 'system', id: 'contract' },
    source: { kind: 'internal', id: 'contract' },
    payload: { eventId },
  });
}

function identity(envelope: EventEnvelope): string {
  return envelope.event.eventId;
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
