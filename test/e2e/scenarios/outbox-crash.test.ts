import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeDeliveryEvent,
  DeliveryEventType,
  DeliveryResultKind,
  DurableFakeDeliveryProvider,
  type DeliveryIntentView,
  type DeliveryResult,
  type ExternalDeliveryAdapter,
  type ReconciliationResult,
} from '../../../src/integrations/index.js';
import { OrchestrationEventType } from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';
import {
  createComposedMergeRoot,
  prepareComposedSafeMerge,
  runComposedDeliveryCycle,
} from './pr-activity-fixtures.js';

const scenario = { id: 'E2E-DELIVERY-001' } as const;
const wakeRoots = new Set<string>();

afterEach(async () => {
  const roots = [...wakeRoots];
  wakeRoots.clear();
  await Promise.all(roots.map((wakeRoot) => rm(wakeRoot, { recursive: true, force: true })));
});

describe(scenario.id, () => {
  it('reconciles provider acceptance after a crash without a second merge', async () => {
    const provider = new DurableFakeDeliveryProvider();
    provider.crashAfterNextEffect();
    const root = await createComposedMergeRoot({ provider });
    wakeRoots.add(root.paths.wakeRoot);
    const workflowId = await prepareComposedSafeMerge(root);

    await expect(runComposedDeliveryCycle(root)).rejects.toThrow(
      'simulated provider crash after accepted effect',
    );

    expect(provider.effects).toHaveLength(1);
    expect(provider.deliveryCalls).toBe(1);
    expect((await root.orchestration.get(workflowId))?.status).toBe('waiting');
    expect(
      (await root.journal.readAll(0)).filter(
        ({ event }) => event.eventType === DeliveryEventType.Confirmed,
      ),
    ).toHaveLength(0);

    await runComposedDeliveryCycle(root);
    await runComposedDeliveryCycle(root);

    expect(provider.effects).toHaveLength(1);
    expect(provider.deliveryCalls).toBe(1);
    expect((await root.orchestration.get(workflowId))?.status).toBe('completed');
    expect(
      (await root.journal.readAll(0)).filter(
        ({ event }) => event.eventType === DeliveryEventType.Reconciled,
      ),
    ).toHaveLength(1);
    expect(
      (await root.journal.readAll(0)).filter(
        ({ event }) => event.eventType === DeliveryEventType.Confirmed,
      ),
    ).toHaveLength(0);
    expect(
      (await root.journal.readAll(0)).filter(
        ({ event }) => event.eventType === OrchestrationEventType.InstanceCompleted,
      ),
    ).toHaveLength(1);
  });

  it(
    'rebuilds unresolved delivery work after projection state and checkpoint loss',
    rebuildUnresolvedDeliveryWork,
  );

  it('uses a new durable event occurrence when reconciliation retries and remains unknown', async () => {
    // Given an ambiguous provider effect that survives each delivery-runtime restart.
    const provider = new EventuallyConsistentDeliveryProvider();
    const clock = new MutableClock();
    const root = await createComposedMergeRoot({ provider, clock });
    wakeRoots.add(root.paths.wakeRoot);
    const workflowId = await prepareComposedSafeMerge(root);

    await runComposedDeliveryCycle(root);

    // When a restart cannot find the effect, it retries with the same provider key.
    clock.advance(1_000);
    await runComposedDeliveryCycle(root);

    // And later restarts repeatedly receive an unknown reconciliation result.
    clock.advance(1_000);
    await runComposedDeliveryCycle(root);
    clock.advance(1_000);
    await runComposedDeliveryCycle(root);

    // Then the provider effect is exactly once and every journal fact is a distinct occurrence.
    expect(provider.effects).toHaveLength(1);
    expect(provider.deliveryCalls).toBe(2);
    expect(provider.reconciliationCalls).toBe(3);
    expect((await root.orchestration.get(workflowId))?.status).toBe('waiting');

    const deliveryEvents = (await root.journal.readAll(0))
      .filter(({ event }) => event.eventType === DeliveryEventType.AttemptStarted)
      .concat(
        (await root.journal.readAll(0)).filter(
          ({ event }) => event.eventType === DeliveryEventType.Ambiguous,
        ),
        (await root.journal.readAll(0)).filter(
          ({ event }) => event.eventType === DeliveryEventType.Reconciled,
        ),
      )
      .map(decodeDeliveryEvent);
    expect(new Set(deliveryEvents.map(({ event }) => event.eventId)).size).toBe(
      deliveryEvents.length,
    );
    for (const event of deliveryEvents)
      expect(event.event.eventId).toBe(
        `${event.event.payload.intentEventId}:${event.event.eventType}:${event.event.payload.occurrenceOrdinal}`,
      );
    expect(
      deliveryEvents
        .filter(({ event }) => event.eventType === DeliveryEventType.AttemptStarted)
        .map(({ event }) => event.payload.occurrenceOrdinal),
    ).toEqual([1, 2]);
    expect(
      deliveryEvents
        .filter(({ event }) => event.eventType === DeliveryEventType.Reconciled)
        .map(({ event }) => event.payload),
    ).toMatchObject([
      { result: DeliveryResultKind.NotFound, occurrenceOrdinal: 2 },
      { result: DeliveryResultKind.Unknown, occurrenceOrdinal: 3 },
      { result: DeliveryResultKind.Unknown, occurrenceOrdinal: 4 },
    ]);
  });
});

async function rebuildUnresolvedDeliveryWork(): Promise<void> {
  // Given a provider effect accepted before Wake records confirmation.
  const provider = new DurableFakeDeliveryProvider();
  provider.crashAfterNextEffect();
  const root = await createComposedMergeRoot({ provider });
  wakeRoots.add(root.paths.wakeRoot);
  const workflowId = await prepareComposedSafeMerge(root);

  await expect(runComposedDeliveryCycle(root)).rejects.toThrow(
    'simulated provider crash after accepted effect',
  );

  // When delivery projections and their checkpoints are lost before restart.
  const restarted = await createComposedMergeRoot({
    provider,
    journal: root.journal,
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
  });
  wakeRoots.add(restarted.paths.wakeRoot);
  expect(restarted.paths.wakeRoot).not.toBe(root.paths.wakeRoot);
  await runComposedDeliveryCycle(restarted);

  // Then journal replay reconciles the original effect without delivering again.
  expect(provider.effects).toHaveLength(1);
  expect(provider.deliveryCalls).toBe(1);
  expect((await restarted.orchestration.get(workflowId))?.status).toBe('completed');
  expect(
    (await restarted.journal.readAll(0)).filter(
      ({ event }) => event.eventType === DeliveryEventType.Reconciled,
    ),
  ).toHaveLength(1);
  expect(
    (await restarted.journal.readAll(0)).filter(
      ({ event }) => event.eventType === OrchestrationEventType.InstanceCompleted,
    ),
  ).toHaveLength(1);
}

class MutableClock {
  private current = new Date('2026-07-30T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class EventuallyConsistentDeliveryProvider implements ExternalDeliveryAdapter {
  readonly effects: string[] = [];
  deliveryCalls = 0;
  reconciliationCalls = 0;
  private readonly reconciliationKey = 'provider-operation-1';

  async deliver(intent: DeliveryIntentView): Promise<DeliveryResult> {
    this.deliveryCalls += 1;
    if (!this.effects.includes(intent.intentEventId)) this.effects.push(intent.intentEventId);
    return {
      kind: DeliveryResultKind.Ambiguous,
      reconciliationKey: this.reconciliationKey,
    };
  }

  async reconcile(): Promise<ReconciliationResult> {
    this.reconciliationCalls += 1;
    return this.reconciliationCalls === 1
      ? { kind: DeliveryResultKind.NotFound }
      : { kind: DeliveryResultKind.Unknown };
  }
}
