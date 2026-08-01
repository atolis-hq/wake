import { describe, expect, it } from 'vitest';
import { composeDeliveryRuntime } from '../../../src-next/bootstrap/index.js';
import {
  decodeDeliveryEvent,
  DeliveryEventType,
  DeliveryResultKind,
  DurableFakeDeliveryProvider,
  type DeliveryIntentView,
  type DeliveryResult,
  type ExternalDeliveryAdapter,
  type ReconciliationResult,
} from '../../../src-next/integrations/index.js';
import { OrchestrationEventType } from '../../../src-next/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryProjectionStore,
} from '../../../src-next/persistence/index.js';
import { TestWorld } from '../support/world.js';
import { executeMerge, setupMergeScenario } from './pr-activity-fixtures.js';

describe('E2E-DELIVERY-001', () => {
  it('reconciles provider acceptance after a crash without a second merge', async () => {
    const world = new TestWorld();
    const setup = await setupMergeScenario(world, 'safe');
    const workflowId = await executeMerge(world, setup.workItemId);
    const provider = new DurableFakeDeliveryProvider();
    provider.crashAfterNextEffect();
    const projections = new InMemoryProjectionStore();
    const dependencies = {
      journal: world.journal,
      projections,
      checkpoints: world.checkpoints,
      resource: async (id: string) => ({ resourceId: id, adapter: 'fake' }),
      adapter: () => provider,
      now: () => world.clock.now().toISOString(),
      orchestration: world.orchestration,
    };

    await expect(
      composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal),
    ).rejects.toThrow('simulated provider crash after accepted effect');

    expect(provider.effects).toHaveLength(1);
    expect(provider.deliveryCalls).toBe(1);
    expect((await world.viewWorkflow(workflowId))?.status).toBe('waiting');
    expect(await world.events(DeliveryEventType.Confirmed)).toHaveLength(0);

    await composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal);
    await composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal);

    expect(provider.effects).toHaveLength(1);
    expect(provider.deliveryCalls).toBe(1);
    expect((await world.viewWorkflow(workflowId))?.status).toBe('completed');
    expect(await world.events(DeliveryEventType.Reconciled)).toHaveLength(1);
    expect(await world.events(DeliveryEventType.Confirmed)).toHaveLength(0);
    expect(await world.events(OrchestrationEventType.InstanceCompleted)).toHaveLength(1);
  });

  it(
    'rebuilds unresolved delivery work after projection state and checkpoint loss',
    rebuildUnresolvedDeliveryWork,
  );

  it('uses a new durable event occurrence when reconciliation retries and remains unknown', async () => {
    // Given an ambiguous provider effect that survives each delivery-runtime restart.
    const world = new TestWorld();
    const setup = await setupMergeScenario(world, 'safe');
    const workflowId = await executeMerge(world, setup.workItemId);
    const provider = new EventuallyConsistentDeliveryProvider();
    const dependencies = {
      journal: world.journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: world.checkpoints,
      resource: async (id: string) => ({ resourceId: id, adapter: 'fake' }),
      adapter: () => provider,
      now: () => world.clock.now().toISOString(),
      orchestration: world.orchestration,
    };

    await composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal);

    // When a restart cannot find the effect, it retries with the same provider key.
    world.clock.advance(1_000);
    await composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal);

    // And later restarts repeatedly receive an unknown reconciliation result.
    world.clock.advance(1_000);
    await composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal);
    world.clock.advance(1_000);
    await composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal);

    // Then the provider effect is exactly once and every journal fact is a distinct occurrence.
    expect(provider.effects).toHaveLength(1);
    expect(provider.deliveryCalls).toBe(2);
    expect(provider.reconciliationCalls).toBe(3);
    expect((await world.viewWorkflow(workflowId))?.status).toBe('waiting');

    const deliveryEvents = (await world.events(DeliveryEventType.AttemptStarted))
      .concat(
        await world.events(DeliveryEventType.Ambiguous),
        await world.events(DeliveryEventType.Reconciled),
      )
      .map(decodeDeliveryEvent);
    expect(new Set(deliveryEvents.map((event) => event.eventId)).size).toBe(deliveryEvents.length);
    for (const event of deliveryEvents)
      expect(event.eventId).toBe(
        `${event.payload.intentEventId}:${event.eventType}:${event.payload.occurrenceOrdinal}`,
      );
    expect(
      deliveryEvents
        .filter((event) => event.eventType === DeliveryEventType.AttemptStarted)
        .map((event) => event.payload.occurrenceOrdinal),
    ).toEqual([1, 2]);
    expect(
      deliveryEvents
        .filter((event) => event.eventType === DeliveryEventType.Reconciled)
        .map((event) => event.payload),
    ).toMatchObject([
      { result: DeliveryResultKind.NotFound, occurrenceOrdinal: 2 },
      { result: DeliveryResultKind.Unknown, occurrenceOrdinal: 3 },
      { result: DeliveryResultKind.Unknown, occurrenceOrdinal: 4 },
    ]);
  });
});

async function rebuildUnresolvedDeliveryWork(): Promise<void> {
  // Given a provider effect accepted before Wake records confirmation.
  const world = new TestWorld();
  const setup = await setupMergeScenario(world, 'safe');
  const workflowId = await executeMerge(world, setup.workItemId);
  const provider = new DurableFakeDeliveryProvider();
  provider.crashAfterNextEffect();
  const dependencies = {
    journal: world.journal,
    projections: new InMemoryProjectionStore(),
    checkpoints: world.checkpoints,
    resource: async (id: string) => ({ resourceId: id, adapter: 'fake' }),
    adapter: () => provider,
    now: () => world.clock.now().toISOString(),
    orchestration: world.orchestration,
  };

  await expect(
    composeDeliveryRuntime(dependencies).runOnce(new AbortController().signal),
  ).rejects.toThrow('simulated provider crash after accepted effect');

  // When delivery projections and their checkpoints are lost before restart.
  const restartedDependencies = {
    ...dependencies,
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
  };
  await composeDeliveryRuntime(restartedDependencies).runOnce(new AbortController().signal);

  // Then journal replay reconciles the original effect without delivering again.
  expect(provider.effects).toHaveLength(1);
  expect(provider.deliveryCalls).toBe(1);
  expect((await world.viewWorkflow(workflowId))?.status).toBe('completed');
  expect(await world.events(DeliveryEventType.Reconciled)).toHaveLength(1);
  expect(await world.events(OrchestrationEventType.InstanceCompleted)).toHaveLength(1);
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
