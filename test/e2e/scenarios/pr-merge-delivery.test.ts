import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryEventType, DurableFakeDeliveryProvider } from '../../../src/integrations/index.js';
import {
  createComposedMergeRoot,
  prepareComposedSafeMerge,
  runComposedDeliveryCycle,
} from './pr-activity-fixtures.js';

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
