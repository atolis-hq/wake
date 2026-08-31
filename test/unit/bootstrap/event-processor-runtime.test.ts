import {
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  createEventData,
  defineEventProcessor,
} from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createInMemoryProcessorRunSerialiser,
} from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { EventProcessorRuntime } from '../../../src/bootstrap/event-processor-runtime.js';
import { type EntityRef } from '../../../src/kernel/index.js';

const clock = { now: () => new Date('2026-08-30T00:00:00.000Z') };

it('hosts every registered processor once and reports its durable position health', async () => {
  const journal = new InMemoryEventJournal(clock);
  const checkpoints = new InMemoryCheckpointStore();
  await appendFact(journal);
  const handled: string[] = [];
  const runtime = new EventProcessorRuntime(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    clock,
  );
  const first = processor('reactor:one', 'reactor-one', async () => {
    handled.push('one');
  });
  const second = processor('translator:two', 'translator-two', async () => {
    handled.push('two');
  });

  runtime.register([first, second]);
  await runtime.catchUp('facts', [first, second]);

  expect(handled).toEqual(['one', 'two']);
  await expect(runtime.health()).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        consumer: 'reactor:one',
        owner: 'test',
        category: EventProcessorCategory.Reactor,
        checkpoint: 1,
        head: 1,
        lag: 0,
      }),
      expect.objectContaining({
        consumer: 'translator:two',
        owner: 'test',
        category: EventProcessorCategory.Translator,
        checkpoint: 1,
        head: 1,
        lag: 0,
      }),
    ]),
  );
  expect(() => runtime.register([first])).toThrow(/already registered/i);
});

it('keeps a degraded processor supervised without stopping a healthy sibling', async () => {
  const journal = new InMemoryEventJournal(clock);
  const checkpoints = new InMemoryCheckpointStore();
  await appendFact(journal);
  let healthy = false;
  const runtime = new EventProcessorRuntime(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    clock,
    {
      retryBackoff: async (_failures, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    },
  );
  runtime.register([
    processor('reactor:failing', 'failing', async () => {
      throw new Error('injected failure');
    }),
    processor('reactor:healthy', 'healthy', async () => {
      healthy = true;
    }),
  ]);

  const run = runtime.start();
  await eventually(
    async () =>
      (await runtime.health()).find(({ consumer }) => consumer === 'reactor:failing')?.status,
    'degraded',
  );
  await eventually(() => healthy, true);
  run.abort();
  await expect(run.done).resolves.toBeUndefined();
});

it('returns the active common host instead of starting the registry twice', async () => {
  const runtime = new EventProcessorRuntime(
    new InMemoryEventJournal(clock),
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    clock,
  );
  runtime.register([processor('reactor:waiting', 'waiting', async () => undefined)]);

  const first = runtime.start();
  const second = runtime.start();

  expect(second).toBe(first);
  first.abort();
  await expect(first.done).resolves.toBeUndefined();
});

function processor(consumer: string, name: string, handle: () => Promise<void>) {
  return defineEventProcessor({
    consumer,
    name,
    owner: 'test',
    category: consumer.startsWith('translator')
      ? EventProcessorCategory.Translator
      : EventProcessorCategory.Reactor,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    select: () => undefined,
    handle: async () => handle(),
  });
}

async function appendFact(journal: InMemoryEventJournal): Promise<void> {
  const stream: EntityRef<'test', 'one'> = { kind: 'test', id: 'one' };
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'test-event-one',
      eventType: 'test.recorded',
      occurredAt: '2026-08-30T00:00:00.000Z',
      correlationId: 'test-correlation',
      causationId: 'test-causation',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { value: 1 },
    }),
  ]);
}

async function eventually<Value>(
  read: () => Promise<Value> | Value,
  expected: Value,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await read()) === expected) return;
    await Promise.resolve();
  }
  expect(await read()).toBe(expected);
}
