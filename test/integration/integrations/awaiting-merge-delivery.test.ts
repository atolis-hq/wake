import { EventActorKind, eventId, EventSourceKind } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { describe, expect, it } from 'vitest';
import {
  ActivityEventType,
  createActivityEventData,
  PullRequestState,
} from '../../../src/activities/index.js';
import {
  createDeliveryEventData,
  createDeliveryIntentEventData,
  DeliveryEventType,
  DeliveryIntentEventType,
  DeliveryResultKind,
  DeliveryService,
  deliveryStream,
  projectDeliveries,
  selectDeliveryEvent,
} from '../../../src/integrations/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId } from '../../support/identities.js';

describe('awaiting merge delivery eligibility', () => {
  for (const path of ['report', 'reply'] as const) {
    it.each(['merged', 'retry-merged', 'unrelated', 'waiting', 'delivered-first'] as const)(
      `${path}: %s ordering survives rebuilding delivery state`,
      async (ordering) => {
        const journal = new InMemoryEventJournal(new FakeClock());
        const awaited = resId('awaited');
        const destination = resId('parent-issue');
        const body = '**Wake: Awaiting merge**\n\nExisting guidance';
        const metadata = {
          occurredAt: '2026-11-19T00:00:00.000Z',
          correlationId: 'correlation',
          causationId: 'cause',
          actor: { kind: EventActorKind.System, id: 'test' },
          source: { kind: EventSourceKind.Internal, id: 'test' },
        };
        const common = {
          workflowInstanceId: 'workflow',
          activationId: 'activation',
          resourceId: destination,
          awaitingMergeResourceId: awaited,
        };
        await journal.appendToStream(resourceStream(destination), 0, [
          createDeliveryIntentEventData(
            path === 'reply'
              ? {
                  ...metadata,
                  eventId: 'publication',
                  eventType: DeliveryIntentEventType.ReplyPublishRequested,
                  payload: { ...common, body, publicationOnly: true },
                }
              : {
                  ...metadata,
                  eventId: 'publication',
                  eventType: DeliveryIntentEventType.AgentRunPublishRequested,
                  payload: {
                    ...common,
                    report: {
                      runId: 'run',
                      startedAt: metadata.occurredAt,
                      finishedAt: metadata.occurredAt,
                      displayBody: body,
                      outcome: 'DONE',
                      metadata: {},
                      awaitingMerge: true,
                    },
                  },
                },
          ),
        ]);
        const observeMerge = async () => {
          await journal.appendToStream(
            resourceStream(ordering === 'unrelated' ? resId('other-pr') : awaited),
            0,
            [
              createActivityEventData({
                ...metadata,
                eventId: 'merged',
                eventType: ActivityEventType.PrStateChanged,
                payload: { state: PullRequestState.Merged },
              }),
            ],
          );
        };
        if (ordering === 'retry-merged') {
          await journal.appendToStream(deliveryStream(eventId('publication')), 0, [
            createDeliveryEventData({
              ...metadata,
              eventId: 'attempt',
              eventType: DeliveryEventType.AttemptStarted,
              payload: {
                intentEventId: eventId('publication'),
                intentGlobalPosition: 1,
                workflowInstanceId: 'workflow',
                activationId: 'activation',
                occurrenceOrdinal: 1,
              },
            }),
          ]);
        }
        const stale = ordering === 'merged' || ordering === 'retry-merged';
        const delivered: unknown[] = [];
        let reconciliations = 0;
        const service = () =>
          new DeliveryService({
            journal,
            intents: async () => projectDeliveries(await journal.readAll(0)),
            resource: async () => ({ resourceId: destination, adapter: 'fake' }),
            adapter: () => ({
              deliver: async (intent) => {
                delivered.push(intent.payload);
                return { kind: DeliveryResultKind.Confirmed, externalId: 'comment' };
              },
              reconcile: async () => {
                reconciliations += 1;
                return { kind: DeliveryResultKind.NotFound };
              },
            }),
            now: () => metadata.occurredAt,
          });
        if (stale || ordering === 'unrelated') await observeMerge();
        await service().deliverNext(new AbortController().signal);
        if (ordering === 'delivered-first') await observeMerge();
        expect(await service().deliverNext(new AbortController().signal)).toBeNull();
        expect(delivered).toHaveLength(stale ? 0 : 1);
        expect(reconciliations).toBe(0);
        if (!stale)
          expect(delivered[0]).toMatchObject(
            path === 'reply' ? { body } : { report: { displayBody: body } },
          );
        const outcomes = (await journal.readAll(0)).map(selectDeliveryEvent).filter(Boolean);
        expect(outcomes.at(-1)?.event).toMatchObject(
          stale
            ? { eventType: DeliveryEventType.Failed, payload: { code: 'publication-superseded' } }
            : { eventType: DeliveryEventType.Confirmed },
        );
      },
    );
  }
});
