import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryEventType, DurableFakeDeliveryProvider } from '../../../src/integrations/index.js';
import {
  createComposedMergeRoot,
  prepareComposedSafeMerge,
  runComposedDeliveryCycle,
} from './pr-activity-fixtures.js';

import { workId } from '../../support/identities.js';

const scenario = { id: 'E2E-PR-MERGE-003' } as const;
const wakeRoots = new Set<string>();

afterEach(async () => {
  const roots = [...wakeRoots];
  wakeRoots.clear();
  await Promise.all(roots.map((wakeRoot) => rm(wakeRoot, { recursive: true, force: true })));
});

describe(scenario.id, () => {
  it('delivers through projections and advances the waiting workflow only after confirmation', async () => {
    const provider = new DurableFakeDeliveryProvider();
    const root = await createComposedMergeRoot({ provider });
    wakeRoots.add(root.paths.wakeRoot);
    const workflowId = await prepareComposedSafeMerge(root);

    await runComposedDeliveryCycle(root);

    expect(provider.effects).toHaveLength(1);
    expect((await root.orchestration.get(workflowId))?.status).toBe('completed');
    expect((await root.journal.readAll(0)).map((event) => event.event.eventType)).toContain(
      DeliveryEventType.Confirmed,
    );
  });
});

it('uses merged evidence to reconcile a pending delivery and follow the configured merged transition', async () => {
  const provider = new DurableFakeDeliveryProvider();
  provider.deferNextDelivery();
  const root = await createComposedMergeRoot({ provider, waitForMerged: true });
  wakeRoots.add(root.paths.wakeRoot);
  const workflowId = await prepareComposedSafeMerge(root);
  await runComposedDeliveryCycle(root);
  expect((await root.orchestration.get(workflowId))?.waitingFor?.signalKind).toBe(
    'delivery-result',
  );
  const observed = (await root.pullRequests.authorityInput(workId('one'))).pullRequests[0]!;
  await root.pullRequests.observe(
    { ...observed, state: 'merged' },
    {
      commandId: 'external-merge',
      correlationId: 'merge' as never,
      occurredAt: '2026-07-30T12:00:01.000Z',
      actor: { kind: 'system', id: 'test' },
    },
  );
  for (let i = 0; i < 4; i++) await runComposedDeliveryCycle(root);
  expect((await root.orchestration.get(workflowId))?.status).toBe('completed');
  // Merge-wait guidance replies are deliveries too; the merge itself must be attempted once.
  expect(provider.mergeDeliveryCalls).toBe(1);
  const reconciliations = (await root.journal.readAll(0)).filter(
    (event) => event.event.eventType === DeliveryEventType.Reconciled,
  );
  expect(reconciliations).toHaveLength(1);
  expect(reconciliations[0]?.event.payload).toMatchObject({ result: 'confirmed' });
});
