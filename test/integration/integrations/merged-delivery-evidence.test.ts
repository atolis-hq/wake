import { eventId } from '@atolis-hq/eventing';
import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { MergeMethod } from '../../../src/activities/index.js';
import { deliveryStream } from '../../../src/integrations/contracts/streams.js';
import { confirmMergedDelivery } from '../../../src/integrations/delivery/application/merged-delivery-evidence.js';
import { createDeliveryEventData } from '../../../src/integrations/delivery/contracts/event-factory.js';
import { DeliveryEventType } from '../../../src/integrations/delivery/contracts/events.js';
import {
  DeliveryIntentKind,
  DeliveryState,
} from '../../../src/integrations/delivery/contracts/vocabulary.js';
import { DurableFakeDeliveryProvider } from '../../../src/integrations/index.js';
import {
  createComposedMergeRoot,
  prepareComposedSafeMerge,
} from '../../e2e/scenarios/pr-activity-fixtures.js';
import { resId, workId } from '../../support/identities.js';

it.each([
  'during-wait',
  'before-wait',
  'different-revision',
  'missing-revision',
  'closed',
  'failed',
  'wrong-intent',
  'wrong-activation',
])('reconciles merged evidence with durable scope: %s', async (scenario) => {
  const root = await createComposedMergeRoot({ provider: new DurableFakeDeliveryProvider() });
  try {
    await prepareComposedSafeMerge(root);
    const intent = {
      intentEventId: eventId('merge-intent'),
      globalPosition: 1,
      workflowInstanceId: 'workflow-merge',
      activationId: 'activation-1',
      kind: DeliveryIntentKind.PrMerge,
      resourceId: resId('primary'),
      payload: {
        kind: DeliveryIntentKind.PrMerge,
        revision: 'revision-a',
        method: MergeMethod.Squash,
        autoMerge: true,
      },
      state: DeliveryState.Pending,
      attempts: 0,
      occurrenceOrdinal: 0,
    } as const;
    await root.pullRequests.observe(
      {
        resourceId: resId('primary'),
        workItemId: workId('one'),
        state: scenario === 'closed' ? 'closed' : 'merged',
        headRevision:
          scenario === 'different-revision'
            ? 'revision-b'
            : scenario === 'missing-revision'
              ? ''
              : 'revision-a',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      {
        commandId: 'external-merge',
        correlationId: 'merge' as never,
        occurredAt: '2026-07-30T12:00:01.000Z',
        actor: { kind: 'system', id: 'test' },
      },
    );
    let waiting = scenario !== 'before-wait';
    const orchestration = {
      get: async () =>
        ({
          workItemId: workId('one'),
          pendingActivation: {
            activationId: scenario === 'wrong-activation' ? 'other' : intent.activationId,
            status: waiting ? 'waiting' : 'active',
          },
          waitingFor: {
            signalKind: 'delivery-result',
            intentEventId: scenario === 'wrong-intent' ? 'other' : intent.intentEventId,
          },
        }) as never,
    };
    if (scenario === 'failed')
      await root.journal.appendToStream(deliveryStream(intent.intentEventId), 0, [
        createDeliveryEventData({
          eventId: 'historical-failure',
          eventType: DeliveryEventType.Failed,
          occurredAt: '2026-07-30T12:00:00.000Z',
          correlationId: 'merge',
          causationId: 'merge',
          actor: { kind: 'system', id: 'test' },
          source: { kind: 'internal', id: 'test' },
          payload: {
            intentEventId: intent.intentEventId,
            intentGlobalPosition: 1,
            workflowInstanceId: intent.workflowInstanceId,
            activationId: intent.activationId,
            occurrenceOrdinal: 1,
            code: 'github-error',
            message: 'failed',
          },
        }),
      ]);
    await confirmMergedDelivery(intent, root.journal, orchestration, root.pullRequests);
    if (scenario === 'before-wait') {
      expect(await root.journal.readStream(deliveryStream(intent.intentEventId))).toHaveLength(0);
      waiting = true;
      await confirmMergedDelivery(intent, root.journal, orchestration, root.pullRequests);
    }
    // A repeated/restarted reconciliation reads the journal and cannot duplicate confirmation.
    await confirmMergedDelivery(intent, root.journal, orchestration, root.pullRequests);
    const facts = await root.journal.readStream(deliveryStream(intent.intentEventId));
    expect(facts.filter((f) => f.event.eventType === DeliveryEventType.Reconciled)).toHaveLength(
      scenario === 'during-wait' || scenario === 'before-wait' ? 1 : 0,
    );
    if (scenario === 'failed')
      expect(facts.map((f) => f.event.eventType)).toEqual([DeliveryEventType.Failed]);
  } finally {
    await rm(root.paths.wakeRoot, { recursive: true, force: true });
  }
});
