import {
  EventProcessorCategory,
  EventProcessorFailure,
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
import {
  EventProcessorRuntime,
  createProcessorFailureLogger,
} from '../../../src/bootstrap/event-processor-runtime.js';
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

it('freezes registration at start and does not partially register an invalid batch', async () => {
  const runtime = new EventProcessorRuntime(
    new InMemoryEventJournal(clock),
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    clock,
  );
  const first = processor('reactor:first', 'first', async () => undefined);
  const duplicate = processor('reactor:duplicate', 'duplicate', async () => undefined);

  expect(() => runtime.register([first, duplicate, duplicate])).toThrow(/already registered/i);
  expect(runtime.processors).toEqual([]);

  runtime.register([first]);
  const run = runtime.start();
  expect(() => runtime.register([duplicate])).toThrow(/started/i);
  run.abort();
  await expect(run.done).resolves.toBeUndefined();
});

it('logs a failing processor stack once and then only at power-of-ten repeats', () => {
  const lines: string[] = [];
  const log = createProcessorFailureLogger((line) => lines.push(line));
  const failure = (message: string) =>
    new EventProcessorFailure({ name: 'p', consumer: 'reactor:p' }, new Error(message));
  for (let attempt = 0; attempt < 100; attempt += 1) log(failure('poison'));
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain('at ');
  expect(lines[1]).toContain('repeated 10 times');
  expect(lines[2]).toContain('repeated 100 times');
  log(failure('different'));
  expect(lines).toHaveLength(4);
  expect(lines[3]).toContain('different');
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

it('settles sibling catch-up before reporting an attributable failure and retries in order', async () => {
  const journal = new InMemoryEventJournal(clock);
  const checkpoints = new InMemoryCheckpointStore();
  await appendFact(journal);
  const diagnostics: Error[] = [];
  const retries: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failing = true;
  const original = new Error('poison event');
  const attempts: string[] = [];
  const runtime = new EventProcessorRuntime(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    clock,
    {
      onFailure: (error) => {
        diagnostics.push(error);
      },
      retryBackoff: async (failures) => {
        retries.push(failures);
      },
    },
  );
  const bad = processor('reactor:bad', 'bad', async () => {
    attempts.push('test-event-one');
    if (failing) throw original;
  });
  const good = processor('reactor:good', 'good', async () => {
    await held;
  });
  runtime.register([bad, good]);
  let settled = false;
  const pass = runtime.catchUp('tick').catch((error: unknown) => {
    settled = true;
    return error;
  });
  await eventually(() => diagnostics.length, 1);
  expect(settled).toBe(false);
  release();
  const failure = await pass;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(String(failure)).toContain('bad (reactor:bad)');
  expect(String(failure)).toContain('test-event-one at global position 1');
  expect(diagnostics[0]?.cause).toBe(original);
  expect(original.stack).toContain('poison event');
  expect(await checkpoints.load(bad.consumer)).toBe(0);
  expect(await checkpoints.load(good.consumer)).toBe(1);
  expect(await runtime.health()).toContainEqual(
    expect.objectContaining({ consumer: bad.consumer, status: 'degraded', consecutiveFailures: 1 }),
  );
  await expect(runtime.catchUp('retry')).rejects.toThrow('poison event');
  failing = false;
  await runtime.catchUp('recovery');
  expect(retries).toEqual([1, 2]);
  expect(attempts).toEqual(['test-event-one', 'test-event-one', 'test-event-one']);
  expect(await checkpoints.load(bad.consumer)).toBe(1);
  expect(await runtime.health()).toContainEqual(
    expect.objectContaining({ consumer: bad.consumer, status: 'healthy', consecutiveFailures: 0 }),
  );
});
