import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeliveryEventType,
  DeliveryIntentKind,
  DurableFakeDeliveryProvider,
} from '../../../src/integrations/index.js';
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
  const deliver = vi.spyOn(provider, 'deliver');
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
  expect(
    deliver.mock.calls.filter(([intent]) => intent.kind === DeliveryIntentKind.PrMerge),
  ).toHaveLength(1);
  const reconciliations = (await root.journal.readAll(0)).filter(
    (event) => event.event.eventType === DeliveryEventType.Reconciled,
  );
  expect(reconciliations).toHaveLength(1);
  expect(reconciliations[0]?.event.payload).toMatchObject({ result: 'confirmed' });
});

it('automatically retries unreadable checks on schedule and merges after passing evidence', async () => {
  const provider = new DurableFakeDeliveryProvider();
  let now = new Date('2026-07-30T12:00:00.000Z');
  const root = await createComposedMergeRoot({
    provider,
    retryChecks: true,
    clock: { now: () => now },
  });
  wakeRoots.add(root.paths.wakeRoot);
  const workflowId = await prepareComposedSafeMerge(root, 'unknown');
  const observed = (await root.pullRequests.authorityInput(workId('one'))).pullRequests[0]!;
  const observe = async (checks: 'unknown' | 'passing') =>
    root.pullRequests.observe(
      { ...observed, checks },
      {
        commandId: `checks-${checks}`,
        correlationId: 'merge' as never,
        occurredAt: now.toISOString(),
        actor: { kind: 'system', id: 'test' },
      },
    );
  await observe('unknown');
  await runComposedDeliveryCycle(root);
  expect(provider.effects).toHaveLength(0);
  expect(await root.orchestration.get(workflowId)).toMatchObject({
    retryCounts: { 'merge:blocked': 1 },
    pendingActivation: { notBefore: '2026-07-30T12:01:00.000Z' },
  });
  await observe('passing');
  now = new Date('2026-07-30T12:00:59.999Z');
  await runComposedDeliveryCycle(root);
  expect(provider.effects).toHaveLength(0);
  now = new Date('2026-07-30T12:01:00.000Z');
  await runComposedDeliveryCycle(root);
  expect(provider.effects).toHaveLength(1);
  expect((await root.orchestration.get(workflowId))?.status).toBe('completed');
});

it.each(['unknown', 'pending', 'failing'] as const)(
  'bounds retries for %s checks and retains the final denial',
  async (checks) => {
    const provider = new DurableFakeDeliveryProvider();
    let now = new Date('2026-07-30T12:00:00.000Z');
    const root = await createComposedMergeRoot({
      provider,
      retryChecks: true,
      clock: { now: () => now },
    });
    wakeRoots.add(root.paths.wakeRoot);
    const workflowId = await prepareComposedSafeMerge(root, checks);
    const observed = (await root.pullRequests.authorityInput(workId('one'))).pullRequests[0]!;
    await root.pullRequests.observe(
      { ...observed, checks },
      {
        commandId: 'checks-denied',
        correlationId: 'merge' as never,
        occurredAt: now.toISOString(),
        actor: { kind: 'system', id: 'test' },
      },
    );
    await runComposedDeliveryCycle(root);
    if (checks !== 'failing') {
      for (const delay of [60000, 300000, 900000]) {
        const waiting = await root.orchestration.get(workflowId);
        expect(waiting?.pendingActivation?.notBefore).toBe(
          new Date(now.getTime() + delay).toISOString(),
        );
        await runComposedDeliveryCycle(root);
        now = new Date(now.getTime() + delay);
        await runComposedDeliveryCycle(root);
      }
    }
    expect(provider.effects).toHaveLength(0);
    expect(await root.orchestration.get(workflowId)).toMatchObject({
      status: 'waiting',
      lastOutcome: {
        kind: 'blocked',
        data: { reason: checks === 'unknown' ? 'checks-could-not-be-read' : `checks-${checks}` },
      },
      retryCounts: checks === 'failing' ? {} : { 'merge:blocked': 3 },
    });
  },
);
