import { describe, expect, it } from 'vitest';
import { ActivityEventType, MergeMethod, activationId } from '../../../src/activities/index.js';
import {
  deliveryProjection,
  projectDeliveries,
} from '../../../src/integrations/delivery/application/delivery-projector.js';
import {
  DeliveryEventType,
  DeliveryIntentEventType,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
  deliveryStream,
} from '../../../src/integrations/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId } from '../../support/identities.js';

describe('delivery projector', () => {
  it('projects an issue completion request as a durable delivery intent', () => {
    const [view] = projectDeliveries([
      eventEnvelope(
        ActivityEventType.IssueCompleteRequested,
        {
          idempotencyKey: 'complete-intent',
          activationId: activationId('activation-complete'),
          workflowInstanceId: 'workflow-complete',
          resourceId: resId('1'),
        },
        resourceStream(resId('1')),
        1,
      ),
    ]);
    expect(view).toMatchObject({
      kind: DeliveryIntentKind.IssueComplete,
      payload: { kind: DeliveryIntentKind.IssueComplete },
    });
  });

  it('preserves an auto-merge request in the projected delivery intent', () => {
    const [view] = projectDeliveries([
      eventEnvelope(
        ActivityEventType.PrMergeRequested,
        {
          idempotencyKey: 'auto-merge-intent',
          activationId: activationId('activation-auto-merge'),
          workflowInstanceId: 'workflow-auto-merge',
          resourceId: resId('1'),
          revision: 'head-a',
          method: MergeMethod.Squash,
          requireChecks: true,
          autoMerge: true,
        },
        resourceStream(resId('1')),
        1,
      ),
    ]);

    expect(view).toMatchObject({
      kind: DeliveryIntentKind.PrMerge,
      payload: { kind: DeliveryIntentKind.PrMerge, method: MergeMethod.Squash, autoMerge: true },
    });
  });

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
          autoMerge: false,
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
        autoMerge: false,
      },
      resourceStream(resId('1')),
      1,
    );
    const correlation = {
      intentEventId: intent.event.eventId,
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
          deliveryStream(intent.event.eventId),
          2,
        ),
      ]),
    ).toMatchObject([
      { intentEventId: intent.event.eventId, globalPosition: 1, state: DeliveryState.Pending },
    ]);
  });

  it.each([
    [DeliveryEventType.Confirmed, { externalId: 'github-42' }, DeliveryState.Confirmed],
    [DeliveryEventType.Failed, { code: 'boom', message: 'transient' }, DeliveryState.Failed],
    [DeliveryEventType.Ambiguous, { reconciliationKey: 'reconcile-1' }, DeliveryState.Ambiguous],
  ] as const)('records when a delivery resolves via %s', (eventType, extra, expectedState) => {
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
        autoMerge: false,
      },
      resourceStream(resId('1')),
      1,
    );
    const resolution = eventEnvelope(
      eventType,
      {
        intentEventId: intent.event.eventId,
        intentGlobalPosition: intent.globalPosition,
        workflowInstanceId: 'workflow-1',
        activationId: 'activation-1',
        occurrenceOrdinal: 1,
        ...extra,
      },
      deliveryStream(intent.event.eventId),
      2,
    );
    const afterIntent = deliveryProjection.project(null, intent);
    const view = deliveryProjection.project(afterIntent, resolution);
    expect(view).toMatchObject({
      state: expectedState,
      resolvedAt: resolution.event.occurredAt,
    });
  });

  it('stays unresolved while a delivery is still pending', () => {
    const intent = eventEnvelope(
      ActivityEventType.IssueCompleteRequested,
      {
        idempotencyKey: 'complete-intent',
        activationId: activationId('activation-complete'),
        workflowInstanceId: 'workflow-complete',
        resourceId: resId('1'),
      },
      resourceStream(resId('1')),
      1,
    );
    const view = deliveryProjection.project(null, intent);
    expect(view).toMatchObject({ state: DeliveryState.Pending });
    expect(view?.resolvedAt).toBeUndefined();
  });
});

describe('delivery integration intents', () => {
  it('projects a dedicated agent-run publication intent separately from status and reply intents', () => {
    const correlation = {
      activationId: activationId('activation-agent'),
      workflowInstanceId: 'workflow-agent',
      resourceId: resId('agent-resource'),
    } as const;
    expect(
      projectDeliveries([
        eventEnvelope(
          DeliveryIntentEventType.AgentRunPublishRequested,
          {
            ...correlation,
            report: {
              runId: 'run-agent',
              startedAt: '2026-08-03T12:00:00.000Z',
              finishedAt: '2026-08-03T12:00:01.000Z',
              displayBody: 'terminal agent report',
              outcome: 'FAILED',
              metadata: {},
            },
          },
          resourceStream(correlation.resourceId),
          1,
        ),
      ])[0],
    ).toMatchObject({
      kind: DeliveryIntentKind.AgentRunPublish,
      payload: {
        kind: DeliveryIntentKind.AgentRunPublish,
        report: { runId: 'run-agent', displayBody: 'terminal agent report', outcome: 'FAILED' },
      },
    });
  });
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
