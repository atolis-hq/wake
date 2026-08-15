import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createResourceTransitionOrdering,
  createTriggerAwareEventJournal,
  createTriggerRegistry,
} from '../../../src/bootstrap/index.js';
import { createEventDraft, EventActorKind, type EventJournal } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('is re-entrant and serializes separate coordinators through the shared file lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-resource-ordering-'));
  const lockPath = join(root, 'resource-transition-ordering.lock');
  const first = createResourceTransitionOrdering(lockPath);
  const second = createResourceTransitionOrdering(lockPath);
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const hasEntered = new Promise<void>((resolve) => (entered = resolve));

  const firstOperation = first(async () => {
    order.push('first-enter');
    await first(async () => order.push('re-enter'));
    entered();
    await held;
    order.push('first-exit');
  });
  await hasEntered;
  const secondOperation = second(async () => order.push('second-enter'));
  await Promise.resolve();
  expect(order).toEqual(['first-enter', 're-enter']);

  release();
  await Promise.all([firstOperation, secondOperation]);
  expect(order).toEqual(['first-enter', 're-enter', 'first-exit', 'second-enter']);
});

it('fails closed instead of spinning forever when the lock is held by a live, unresponsive holder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-resource-ordering-timeout-'));
  const lockPath = join(root, 'resource-transition-ordering.lock');
  const first = createResourceTransitionOrdering(lockPath);
  const second = createResourceTransitionOrdering(lockPath, 50);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));

  const firstOperation = first(async () => {
    await held;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  await expect(second(async () => 'unreachable')).rejects.toThrow(
    /Timed out.*resource-transition ordering lock/,
  );

  release();
  await firstOperation;
});

it('coordinates only appends containing a frozen registered trigger', async () => {
  const registry = createTriggerRegistry();
  registry.register(['pr.state-changed']);
  registry.freeze();
  const coordinated: string[][] = [];
  const appended: string[][] = [];
  const underlying = {
    async append(_stream, _sequence, events) {
      appended.push(events.map(({ eventType }) => eventType));
      return [];
    },
    async readAll() {
      return [];
    },
    async readStream() {
      return [];
    },
  } satisfies EventJournal;
  const journal = createTriggerAwareEventJournal(underlying, registry, async (operation) => {
    const result = await operation();
    coordinated.push(appended.at(-1)!);
    return result;
  });
  const stream = { kind: 'test' as const, id: 'ordering' };
  const draft = (eventType: string) =>
    createEventDraft({
      eventId: `event-${eventType}`,
      eventType,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {},
    });

  await journal.append(stream, 0, [draft('work.unrelated')]);
  await journal.append(stream, 0, [draft('work.unrelated'), draft('pr.state-changed')]);

  expect(appended).toEqual([['work.unrelated'], ['work.unrelated', 'pr.state-changed']]);
  expect(coordinated).toEqual([['work.unrelated', 'pr.state-changed']]);
  expect(() => registry.register(['late.trigger'])).toThrow('frozen');
});

it('prevents a racing trigger append from landing between drain and signal acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-resource-race-'));
  const coordinate = createResourceTransitionOrdering(join(root, 'ordering.lock'));
  const registry = createTriggerRegistry();
  registry.register(['pr.state-changed']);
  registry.freeze();
  const underlying = new InMemoryEventJournal(new FakeClock());
  const journal = createTriggerAwareEventJournal(underlying, registry, coordinate);
  const signalStream = { kind: 'workflow-instance' as const, id: 'workflow-1' };
  const factStream = { kind: 'resource' as const, id: 'pr-1' };
  const draft = (eventType: string, stream: typeof signalStream | typeof factStream) =>
    createEventDraft({
      eventId: `event-${eventType}`,
      eventType,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      actor: { kind: EventActorKind.System, id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {},
    });
  let drainCompleted!: () => void;
  const drained = new Promise<void>((resolve) => (drainCompleted = resolve));
  let allowAcceptance!: () => void;
  const acceptanceAllowed = new Promise<void>((resolve) => (allowAcceptance = resolve));

  const acceptance = coordinate(async () => {
    // The reactor checkpoint is caught up at this point.
    drainCompleted();
    await acceptanceAllowed;
    await journal.append(signalStream, 0, [draft('orchestration.signal-accepted', signalStream)]);
  });
  await drained;
  const racingFact = journal.append(factStream, 0, [draft('pr.state-changed', factStream)]);
  await Promise.resolve();
  expect(await underlying.readAll(0)).toEqual([]);

  allowAcceptance();
  await Promise.all([acceptance, racingFact]);

  expect((await underlying.readAll(0)).map(({ eventType }) => eventType)).toEqual([
    'orchestration.signal-accepted',
    'pr.state-changed',
  ]);
});
