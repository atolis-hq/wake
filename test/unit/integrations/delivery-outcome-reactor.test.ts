import {
  createEventData,
  eventId,
  EventProcessorHost,
  type ProcessorRunSerialiser,
  type ProcessorStateStore,
} from '@atolis-hq/eventing';
import { FileProcessorStateStore } from '@atolis-hq/eventing-filesystem';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProcessorStateStore,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { encode } from '../../../packages/eventing-filesystem/src/file-projection-store.js';
import { deliveryStream } from '../../../src/integrations/contracts/streams.js';
import { DeliveryOutcomeReactor } from '../../../src/integrations/delivery/application/delivery-outcome-reactor.js';
import { DeliveryEventType } from '../../../src/integrations/delivery/contracts/events.js';

const clock = { now: () => new Date('2026-08-09T00:00:00.000Z') };
const unitSerialiseRun = createInMemoryProcessorRunSerialiser();

type DeliveryOutcomeReactorArguments = ConstructorParameters<typeof DeliveryOutcomeReactor>;

function createReactor(
  journal: DeliveryOutcomeReactorArguments[0],
  orchestration: DeliveryOutcomeReactorArguments[1],
  projections: DeliveryOutcomeReactorArguments[2],
  states: ProcessorStateStore = new InMemoryProcessorStateStore(),
  conversations?: DeliveryOutcomeReactorArguments[4],
) {
  return new DeliveryOutcomeReactor(
    journal,
    orchestration,
    projections,
    states,
    conversations,
    unitSerialiseRun,
  );
}

interface StoredPendingDeliveryOutcome {
  readonly eventId: string;
  readonly eventType: string;
  readonly correlationId: string;
  readonly recordedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

it('exposes its stable event processor identity', () => {
  const reactor = createReactor({} as never, {} as never, {} as never);

  expect(reactor).toMatchObject({
    processor: {
      consumer: 'reactor:delivery-outcomes',
      name: 'delivery-outcomes',
      owner: 'integrations',
    },
  });
});

it('skips facts outside the delivery namespace', () => {
  const reactor = createReactor({} as never, {} as never, {} as never);

  expect(
    (reactor.processor as never as { select: (event: unknown) => unknown }).select({
      event: { eventType: 'work.created' },
    }),
  ).toBeNull();
});

it('reads and normalizes legacy pending confirmation state from its exact existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-legacy-pending-delivery-'));
  const namespace = 'reactor:delivery-outcomes:pending';
  const key = 'pending-confirmations';
  const directory = join(root, 'projections', encode(namespace));
  await mkdir(directory, { recursive: true });
  await copyFile(
    join(process.cwd(), 'test', 'fixtures', 'projections', 'legacy-flat-pending-delivery.json'),
    join(directory, `${encode(key)}.json`),
  );
  const states = new FileProcessorStateStore(root);
  const reactor = createReactor(
    new InMemoryEventJournal(clock),
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
        } as never;
      },
      async acceptOutcome() {
        throw new Error('An active activation must leave the delivery pending');
      },
    },
    new InMemoryProjectionStore(),
    states,
  );

  await reactor.reconcileOnce();

  const stored = await states.read<{
    readonly events: readonly StoredPendingDeliveryOutcome[];
  }>('reactor:delivery-outcomes', key);
  expect(stored?.value.events).toEqual([
    {
      eventId: 'intent-1:confirmed',
      eventType: DeliveryEventType.Confirmed,
      correlationId: 'delivery-outcome-test',
      recordedAt: '2026-08-09T00:00:01.000Z',
      payload: {
        intentEventId: 'intent-1',
        intentGlobalPosition: 1,
        workflowInstanceId: 'primary:work-1',
        activationId: 'primary:work-1:activity:1',
        occurrenceOrdinal: 1,
        externalId: 'external-1',
      },
    },
  ]);
});

it('fails recovery before rewriting corrupt pending state or advancing its checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-corrupt-pending-delivery-'));
  const consumer = 'reactor:delivery-outcomes';
  const key = 'pending-confirmations';
  const path = join(root, 'projections', encode(`${consumer}:pending`), `${encode(key)}.json`);
  const raw = `${JSON.stringify({ namespace: '', key, lastGlobalPosition: 0, value: { events: [] } })}\n`;
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, raw);
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const checkpoints = new InMemoryCheckpointStore();
  let accepted = 0;
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
        } as never;
      },
      async acceptOutcome() {
        accepted += 1;
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
    new FileProcessorStateStore(root),
  );
  const host = new EventProcessorHost(journal, checkpoints, unitSerialiseRun, clock);

  await expect(reactor.reconcileOnce()).rejects.toThrow('Invalid processor state record');
  await expect(host.runOnce(reactor.processor)).rejects.toThrow('Invalid processor state record');

  expect(await checkpoints.load(consumer)).toBe(0);
  expect(accepted).toBe(0);
  await expect(readFile(path, 'utf8')).resolves.toBe(raw);
});

function confirmedEvent(overrides: {
  readonly intentEventId?: string;
  readonly workflowInstanceId?: string;
  readonly activationId?: string;
}) {
  const intentEventId = overrides.intentEventId ?? 'intent-1';
  return createEventData({
    eventId: `${intentEventId}:confirmed`,
    eventType: DeliveryEventType.Confirmed,
    occurredAt: clock.now().toISOString(),
    correlationId: 'delivery-outcome-test',
    causationId: 'delivery-outcome-test',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: {
      intentEventId,
      intentGlobalPosition: 1,
      workflowInstanceId: overrides.workflowInstanceId ?? 'primary:work-1',
      activationId: overrides.activationId ?? 'primary:work-1:activity:1',
      occurrenceOrdinal: 1,
      externalId: 'external-1',
    },
  }) as never;
}

function failedEvent() {
  return createEventData({
    eventId: 'intent-1:failed',
    eventType: DeliveryEventType.Failed,
    occurredAt: clock.now().toISOString(),
    correlationId: 'delivery-outcome-test',
    causationId: 'delivery-outcome-test',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: {
      intentEventId: 'intent-1',
      intentGlobalPosition: 1,
      workflowInstanceId: 'primary:work-1',
      activationId: 'primary:work-1:activity:1',
      occurrenceOrdinal: 1,
      code: 'denied',
      message: 'Delivery was denied',
    },
  }) as never;
}

function reconciledConfirmedEvent() {
  return createEventData({
    eventId: 'intent-1:reconciled',
    eventType: DeliveryEventType.Reconciled,
    occurredAt: clock.now().toISOString(),
    correlationId: 'delivery-outcome-test',
    causationId: 'delivery-outcome-test',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: {
      intentEventId: 'intent-1',
      intentGlobalPosition: 1,
      workflowInstanceId: 'primary:work-1',
      activationId: 'primary:work-1:activity:1',
      occurrenceOrdinal: 1,
      result: 'confirmed',
      externalId: 'external-1',
    },
  }) as never;
}

it('projects live journal envelopes into canonical pending delivery records idempotently', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  await journal.appendToStream(deliveryStream(eventId('intent-2')), 0, [
    confirmedEvent({
      intentEventId: 'intent-2',
      workflowInstanceId: 'primary:work-2',
      activationId: 'primary:work-2:activity:1',
    }),
  ]);
  const projections = new InMemoryProjectionStore();
  const states = new InMemoryProcessorStateStore();
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'unrelated', status: 'active' },
        } as never;
      },
      async acceptOutcome() {
        throw new Error('An active activation must leave the delivery pending');
      },
    },
    projections,
    states,
  );
  const events = await journal.readAll(0);

  await reactor.react(events[0]!);
  await reactor.react(events[1]!);
  await reactor.react(events[0]!);

  const stored = await states.read<{
    readonly events: readonly StoredPendingDeliveryOutcome[];
  }>('reactor:delivery-outcomes', 'pending-confirmations');
  expect(stored?.value.events).toEqual([
    {
      eventId: 'intent-1:confirmed',
      eventType: DeliveryEventType.Confirmed,
      correlationId: 'delivery-outcome-test',
      recordedAt: clock.now().toISOString(),
      payload: expect.objectContaining({
        intentEventId: 'intent-1',
        workflowInstanceId: 'primary:work-1',
      }),
    },
    {
      eventId: 'intent-2:confirmed',
      eventType: DeliveryEventType.Confirmed,
      correlationId: 'delivery-outcome-test',
      recordedAt: clock.now().toISOString(),
      payload: expect.objectContaining({
        intentEventId: 'intent-2',
        workflowInstanceId: 'primary:work-2',
      }),
    },
  ]);
});

it('keeps pending confirmation recovery state out of delivery intent projections', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const projections = new InMemoryProjectionStore();
  const states = new InMemoryProcessorStateStore();
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
        } as never;
      },
      async acceptOutcome() {
        throw new Error('An active activation must leave the delivery pending');
      },
    },
    projections,
    states,
  );

  await reactor.react((await journal.readAll(0))[0]!);

  await expect(
    states.read('reactor:delivery-outcomes', 'pending-confirmations'),
  ).resolves.not.toBeNull();
  await expect(
    projections.read('reactor:delivery-outcomes:pending', 'pending-confirmations'),
  ).resolves.toBeNull();
});

it('preserves a live processor outcome while pending reconciliation is in progress', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  await journal.appendToStream(deliveryStream(eventId('intent-2')), 0, [
    confirmedEvent({
      intentEventId: 'intent-2',
      workflowInstanceId: 'primary:work-2',
      activationId: 'primary:work-2:activity:1',
    }),
  ]);
  const reconciliationEntered = deferred<void>();
  const releaseReconciliation = deferred<void>();
  let blockReconciliation = false;
  const projections = new InMemoryProjectionStore();
  const states = new InMemoryProcessorStateStore();
  const baseSerialiseRun = createInMemoryProcessorRunSerialiser();
  let serialisedCalls = 0;
  const serialiseRun: ProcessorRunSerialiser = (consumer, signal, operation) => {
    serialisedCalls += 1;
    if (serialisedCalls === 2) releaseReconciliation.resolve();
    return baseSerialiseRun(consumer, signal, operation);
  };
  const reactor = Reflect.construct(DeliveryOutcomeReactor, [
    journal,
    {
      async get(id: string) {
        if (blockReconciliation && id === 'primary:work-1') {
          reconciliationEntered.resolve();
          await releaseReconciliation.promise;
        }
        return {
          pendingActivation: {
            activationId:
              id === 'primary:work-1' ? 'primary:work-1:activity:1' : 'primary:work-2:activity:1',
            status: 'active',
          },
        } as never;
      },
      async acceptOutcome() {
        throw new Error('An active activation must leave the delivery pending');
      },
    },
    projections,
    states,
    undefined,
    serialiseRun,
  ]) as DeliveryOutcomeReactor;
  const events = await journal.readAll(0);
  await reactor.react(events[0]!);
  const host = new EventProcessorHost(journal, new InMemoryCheckpointStore(), serialiseRun, clock);
  serialisedCalls = 0;
  blockReconciliation = true;

  const reconciliation = reactor.reconcileOnce();
  await reconciliationEntered.promise;
  const livePass = host.runOnce(reactor.processor);
  void livePass.then(() => releaseReconciliation.resolve());
  await Promise.all([reconciliation, livePass]);

  const stored = await states.read<{
    readonly events: readonly StoredPendingDeliveryOutcome[];
  }>('reactor:delivery-outcomes', 'pending-confirmations');
  expect(stored?.value.events.map(({ eventId: id }) => id)).toEqual([
    'intent-1:confirmed',
    'intent-2:confirmed',
  ]);
});

it('rewrites interim nested pending envelopes to canonical delivery records', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const [envelope] = await journal.readAll(0);
  const projections = new InMemoryProjectionStore();
  const states = new InMemoryProcessorStateStore();
  await states.write({
    consumer: 'reactor:delivery-outcomes',
    key: 'pending-confirmations',
    value: { events: [envelope!] },
  });
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
        } as never;
      },
      async acceptOutcome() {
        throw new Error('An active activation must leave the delivery pending');
      },
    },
    projections,
    states,
  );

  await reactor.reconcileOnce();

  const stored = await states.read<{
    readonly events: readonly StoredPendingDeliveryOutcome[];
  }>('reactor:delivery-outcomes', 'pending-confirmations');
  expect(stored?.value.events).toEqual([
    {
      eventId: 'intent-1:confirmed',
      eventType: DeliveryEventType.Confirmed,
      correlationId: 'delivery-outcome-test',
      recordedAt: clock.now().toISOString(),
      payload: {
        intentEventId: 'intent-1',
        intentGlobalPosition: 1,
        workflowInstanceId: 'primary:work-1',
        activationId: 'primary:work-1:activity:1',
        occurrenceOrdinal: 1,
        externalId: 'external-1',
      },
    },
  ]);
});

it('resolves an activation that is genuinely waiting on this delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
          waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.react((await journal.readAll(0))[0]!);
  await reactor.reconcileOnce();

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    activationId: 'primary:work-1:activity:1',
    outcome: { kind: 'done' },
  });
});

it('catches up a matching confirmation that was checkpointed before its delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  let isWaiting = false;
  const reactor = createReactor(
    journal,
    {
      async get() {
        return isWaiting
          ? ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
              waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
            } as never)
          : ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
            } as never);
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.react((await journal.readAll(0))[0]!);
  isWaiting = true;
  await reactor.reconcileOnce();

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    activationId: 'primary:work-1:activity:1',
    outcome: { kind: 'done' },
  });
});

it('catches up a confirmation when its delivery wait appears during reconciliation', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  let reads = 0;
  const reactor = createReactor(
    journal,
    {
      async get() {
        reads += 1;
        return reads === 1
          ? ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
            } as never)
          : ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
              waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
            } as never);
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.react((await journal.readAll(0))[0]!);
  await reactor.reconcileOnce();

  expect(accepted).toHaveLength(1);
});

it('catches up a matching failure that was checkpointed before its delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [failedEvent()]);
  const accepted: unknown[] = [];
  let isWaiting = false;
  const reactor = createReactor(
    journal,
    {
      async get() {
        return isWaiting
          ? ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
              waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
            } as never)
          : ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
            } as never);
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.react((await journal.readAll(0))[0]!);
  isWaiting = true;
  await reactor.reconcileOnce();

  expect(accepted).toMatchObject([{ outcome: { kind: 'failed', data: { reason: 'denied' } } }]);
});

it('resolves a confirmed reconciliation for its matching delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    reconciledConfirmedEvent(),
  ]);
  const accepted: unknown[] = [];
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
          waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.react((await journal.readAll(0))[0]!);

  expect(accepted).toMatchObject([{ outcome: { kind: 'done' } }]);
});

it('does not resolve a merely-still-open activation that never asked to wait on delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = createReactor(
    journal,
    {
      async get() {
        // A plain agent activation left pending for an unrelated reason (e.g.
        // its own outcome had no configured route) — never declared it was
        // waiting on this or any delivery.
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
          waitingFor: undefined,
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.react((await journal.readAll(0))[0]!);

  expect(accepted).toHaveLength(0);
});

it('does not resolve a different activation even if it is waiting on an unrelated delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
          // Waiting, but on a different intent than the one that just confirmed.
          waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-other' },
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.react((await journal.readAll(0))[0]!);

  expect(accepted).toHaveLength(0);
});

it('continues delivery reconciliation when recording conversation provenance fails', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = createReactor(
    journal,
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
          waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    {
      list: async () => [
        {
          value: {
            intentEventId: 'intent-1',
            resourceId: 'resource-1',
            payload: {
              kind: 'agent-run.publish',
              conversationId: 'conversation-00000000000000000000000001',
              conversationEntryId: 'agent-run-1',
            },
          },
        },
      ],
      read: async () => null,
      write: async () => undefined,
    } as never,
    new InMemoryProcessorStateStore(),
    { recordRepresentation: async () => Promise.reject(new Error('conversation unavailable')) },
  );

  await expect(reactor.react((await journal.readAll(0))[0]!)).resolves.toBeUndefined();

  expect(accepted).toHaveLength(1);
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
