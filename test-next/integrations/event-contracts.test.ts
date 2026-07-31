import { describe, expect, it } from 'vitest';
import {
  BuiltInAdapterId,
  createDeliveryEventDraft,
  decodeDeliveryEvent,
  decodeGitHubAdapterEvent,
  DeliveryEventType,
  deliveryStream,
  GitHubEventType,
  integrationStream,
  selectDeliveryEvent,
  selectGitHubAdapterEvent,
} from '../../src-next/integrations/index.js';
import { eventEnvelope } from '../support/event-envelope.js';

const stream = integrationStream(BuiltInAdapterId.GitHub);
const actor = { id: 'octocat', kind: 'human' } as const;
const samples = [
  [
    GitHubEventType.WorkObserved,
    {
      externalKey: 'atolis/wake#1',
      kind: 'pull-request',
      title: 'Typed events',
      body: 'Ship them',
      state: 'open',
      revision: 'abc',
      headRevision: 'abc',
      baseRevision: 'def',
      checks: 'passing',
      actor,
      raw: { number: 1 },
    },
  ],
  [
    GitHubEventType.CommentObserved,
    {
      externalKey: 'atolis/wake#1',
      body: '/accepted',
      revision: 'abc',
      actor,
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'octocat' },
      raw: { reviewId: 1 },
    },
  ],
  [GitHubEventType.DeliveryObserved, { deliveryId: 'delivery-1', raw: { status: 'ok' } }],
] as const;

describe('GitHub adapter event contract', () => {
  it('decodes every declared event with its exact payload and stream', () => {
    expect(
      samples.map(([type, payload]) =>
        decodeGitHubAdapterEvent(eventEnvelope(type, payload, stream)),
      ),
    ).toHaveLength(Object.keys(GitHubEventType).length);
  });

  it('rejects unknown, malformed, and wrong-stream owned events', () => {
    expect(() =>
      decodeGitHubAdapterEvent(eventEnvelope('integration.github.unknown', {}, stream)),
    ).toThrow();
    expect(() =>
      decodeGitHubAdapterEvent(
        eventEnvelope(GitHubEventType.WorkObserved, { externalKey: 'wake#1' }, stream),
      ),
    ).toThrow();
    expect(() =>
      decodeGitHubAdapterEvent(
        eventEnvelope(GitHubEventType.DeliveryObserved, samples[2][1], {
          kind: 'resource',
          id: 'resource-1',
        }),
      ),
    ).toThrow();
  });

  it('selects unrelated namespaces as null but throws for invalid owned events', () => {
    expect(selectGitHubAdapterEvent(eventEnvelope('work.item-created', {}, stream))).toBeNull();
    expect(() =>
      selectGitHubAdapterEvent(eventEnvelope('integration.github.unknown', {}, stream)),
    ).toThrow(/event-7.*position 7.*integration\.github\.unknown/i);
  });
});

describe('Delivery event contract', () => {
  const delivery = deliveryStream('intent-1');
  const confirmed = {
    intentEventId: 'intent-1',
    intentGlobalPosition: 4,
    workflowInstanceId: 'workflow-1',
    activationId: 'activation-1',
    occurrenceOrdinal: 1,
    externalId: 'github-42',
  } as const;

  it('decodes owned delivery events on their exact delivery stream', () => {
    const draft = createDeliveryEventDraft({
      eventId: 'delivery-confirmed-1',
      eventType: DeliveryEventType.Confirmed,
      occurredAt: '2026-07-31T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'intent-1',
      actor: { kind: 'system', id: 'delivery' },
      source: { kind: 'internal', id: 'delivery' },
      stream: delivery,
      payload: confirmed,
    });

    expect(
      decodeDeliveryEvent({
        ...draft,
        recordedAt: draft.occurredAt,
        sequence: 1,
        globalPosition: 5,
      }),
    ).toMatchObject({
      eventType: DeliveryEventType.Confirmed,
      payload: confirmed,
      stream: delivery,
    });
  });

  it('returns null for unrelated namespaces and rejects malformed or crossed owned events', () => {
    expect(selectDeliveryEvent(eventEnvelope('work.item-created', {}, delivery))).toBeNull();
    expect(() =>
      decodeDeliveryEvent(
        eventEnvelope(DeliveryEventType.Confirmed, { intentEventId: 'intent-1' }, delivery),
      ),
    ).toThrow();
    expect(() =>
      decodeDeliveryEvent(
        eventEnvelope(
          DeliveryEventType.Confirmed,
          confirmed,
          integrationStream(BuiltInAdapterId.GitHub),
        ),
      ),
    ).toThrow();
  });

  it('rejects a delivery event whose stream identifies a different intent', () => {
    expect(() =>
      decodeDeliveryEvent(
        eventEnvelope(DeliveryEventType.Confirmed, confirmed, deliveryStream('intent-2')),
      ),
    ).toThrow(/intent/i);
  });

  it('requires an external id only for a confirmed reconciliation', () => {
    const correlation = {
      intentEventId: 'intent-1',
      intentGlobalPosition: 4,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      occurrenceOrdinal: 1,
    } as const;

    expect(() =>
      decodeDeliveryEvent(
        eventEnvelope(
          DeliveryEventType.Reconciled,
          { ...correlation, result: 'confirmed' },
          delivery,
        ),
      ),
    ).toThrow(/externalId/i);
    expect(() =>
      decodeDeliveryEvent(
        eventEnvelope(
          DeliveryEventType.Reconciled,
          { ...correlation, result: 'not-found', externalId: 'github-42' },
          delivery,
        ),
      ),
    ).toThrow(/externalId/i);
    expect(() =>
      decodeDeliveryEvent(
        eventEnvelope(
          DeliveryEventType.Reconciled,
          { ...correlation, result: 'unknown', externalId: 'github-42' },
          delivery,
        ),
      ),
    ).toThrow(/externalId/i);
  });
});
