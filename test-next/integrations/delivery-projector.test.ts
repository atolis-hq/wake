import { describe, expect, it } from 'vitest';
import { ActivityEventType, MergeMethod, activationId } from '../../src-next/activities/index.js';
import { projectDeliveries } from '../../src-next/integrations/delivery/application/delivery-projector.js';
import {
  DeliveryEventType,
  DeliveryIntentEventType,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
  deliveryStream,
} from '../../src-next/integrations/index.js';
import { resourceStream } from '../../src-next/resources/index.js';
import { eventEnvelope } from '../support/event-envelope.js';
import { resId } from '../support/identities.js';

describe('delivery projector', () => {
  it('projects unresolved intent positions without copying payload authority', () => {
    const views = projectDeliveries([
      eventEnvelope(
        ActivityEventType.PrMergeRequested,
        {
          idempotencyKey: 'merge-intent',
          activationId: activationId('activation-2'),
          workflowInstanceId: 'workflow-2',
          resourceId: resId('1'),
          revision: 'b',
          method: MergeMethod.Merge,
          requireChecks: true,
        },
        resourceStream(resId('1')),
        2,
      ),
      eventEnvelope(
        ActivityEventType.PrApproveRequested,
        {
          idempotencyKey: 'approve-intent',
          activationId: activationId('activation-1'),
          workflowInstanceId: 'workflow-1',
          resourceId: resId('1'),
          revision: 'a',
          body: 'ok',
        },
        resourceStream(resId('1')),
        1,
      ),
    ]);
    expect(views.map((view) => [view.intentEventId, view.globalPosition])).toEqual([
      ['event-1', 1],
      ['event-2', 2],
    ]);
  });

  it('applies delivery facts only when both intent id and position identify the view', () => {
    const intent = eventEnvelope(
      ActivityEventType.PrMergeRequested,
      {
        idempotencyKey: 'merge-intent',
        activationId: activationId('activation-1'),
        workflowInstanceId: 'workflow-1',
        resourceId: resId('1'),
        revision: 'a',
        method: MergeMethod.Merge,
        requireChecks: true,
      },
      resourceStream(resId('1')),
      1,
    );
    const correlation = {
      intentEventId: intent.eventId,
      intentGlobalPosition: 99,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      occurrenceOrdinal: 1,
    } as const;

    expect(
      projectDeliveries([
        intent,
        eventEnvelope(
          DeliveryEventType.Reconciled,
          { ...correlation, result: DeliveryResultKind.Confirmed, externalId: 'github-42' },
          deliveryStream(intent.eventId),
          2,
        ),
      ]),
    ).toMatchObject([
      { intentEventId: intent.eventId, globalPosition: 1, state: DeliveryState.Pending },
    ]);
  });
});

describe('delivery integration intents', () => {
  it('retains provider status and reply delivery intents', () => {
    const correlation = {
      activationId: activationId('activation-1'),
      workflowInstanceId: 'workflow-1',
      resourceId: resId('1'),
    } as const;

    expect(
      projectDeliveries([
        eventEnvelope(
          DeliveryIntentEventType.StatusPublishRequested,
          { ...correlation, body: 'checks are passing' },
          resourceStream(correlation.resourceId),
          1,
        ),
        eventEnvelope(
          DeliveryIntentEventType.ReplyPublishRequested,
          { ...correlation, body: 'merge queued' },
          resourceStream(correlation.resourceId),
          2,
        ),
      ]).map(({ kind, payload }) => ({ kind, payload })),
    ).toEqual([
      {
        kind: DeliveryIntentKind.StatusPublish,
        payload: { kind: DeliveryIntentKind.StatusPublish, body: 'checks are passing' },
      },
      {
        kind: DeliveryIntentKind.ReplyPublish,
        payload: { kind: DeliveryIntentKind.ReplyPublish, body: 'merge queued' },
      },
    ]);
  });
});
