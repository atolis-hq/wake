import { describe, expect, it } from 'vitest';
import {
  activityDecisionStream,
  activationId,
  ActivityEventType,
  decodeActivityEvent,
  selectActivityEvent,
} from '../../src-next/activities/index.js';
import { createEventDraft } from '../../src-next/kernel/index.js';
import { resourceId, resourceStream } from '../../src-next/resources/index.js';
import { workItemId, workItemStream } from '../../src-next/work/index.js';
import { eventEnvelope } from '../support/event-envelope.js';

const resource = resourceStream(resourceId('resource-1'));
const work = workItemStream(workItemId('work-1'));
const activation = activationId('activation-1');
const approveDecision = activityDecisionStream(activation, 'approve');
const mergeDecision = activityDecisionStream(activation, 'merge');
const context = {
  workItemId: workItemId('work-1'),
  state: 'open',
  headRevision: 'abc',
  baseRevision: 'def',
  checks: 'passing',
} as const;
const approveIntent = createEventDraft({
  eventId: 'approve-intent',
  eventType: ActivityEventType.PrApproveRequested,
  occurredAt: '2026-07-31T12:00:00.000Z',
  correlationId: 'correlation-1',
  causationId: 'causation-1',
  actor: { kind: 'system', id: 'test' },
  source: { kind: 'internal', id: 'activities-pr' },
  stream: resource,
  payload: {
    idempotencyKey: 'approve-intent',
    activationId: activation,
    resourceId: resourceId('resource-1'),
    revision: 'abc',
    body: null,
  },
});
const mergeIntent = createEventDraft({
  ...approveIntent,
  eventId: 'merge-intent',
  eventType: ActivityEventType.PrMergeRequested,
  payload: {
    idempotencyKey: 'merge-intent',
    activationId: activation,
    resourceId: resourceId('resource-1'),
    revision: 'abc',
    method: 'squash',
    requireChecks: true,
  },
});

const samples = [
  eventEnvelope(ActivityEventType.PrDiscovered, context, resource),
  eventEnvelope(
    ActivityEventType.PrRevisionChanged,
    { headRevision: 'ghi', baseRevision: 'def' },
    resource,
  ),
  eventEnvelope(ActivityEventType.PrStateChanged, { state: 'merged' }, resource),
  eventEnvelope(ActivityEventType.PrChecksChanged, { checks: 'failing' }, resource),
  eventEnvelope(
    ActivityEventType.PrReviewAccepted,
    { revision: 'ghi', actorId: 'reviewer' },
    resource,
  ),
  eventEnvelope(
    ActivityEventType.ReviewAcceptanceSignalRecorded,
    {
      revision: 'ghi',
      actorId: 'reviewer',
      actorKind: 'human',
      acceptedEventId: 'accepted-1',
      providerEventId: 'provider-1',
      trusted: true,
    },
    resource,
  ),
  eventEnvelope(
    ActivityEventType.PrReviewChangesRequested,
    { revision: 'ghi', actorId: 'reviewer' },
    resource,
  ),
  eventEnvelope(ActivityEventType.PrReviewRejected, { reason: 'stale-approval' }, resource),
  eventEnvelope(
    ActivityEventType.PrMergeDenied,
    {
      activationId: activation,
      idempotencyKey: 'merge-denied',
      reason: 'checks-failing',
      resourceId: resourceId('resource-1'),
      revision: 'ghi',
      method: 'squash',
    },
    resource,
  ),
  eventEnvelope(
    ActivityEventType.PrApproveDenied,
    {
      activationId: activation,
      idempotencyKey: 'approve-denied',
      reason: 'missing-resource',
      target: 'primary',
      candidates: [],
      resourceId: null,
      revision: null,
      body: null,
    },
    work,
  ),
  eventEnvelope(ActivityEventType.PrMergeAuthorized, { revision: 'ghi' }, resource),
  eventEnvelope(ActivityEventType.PrApproveRequested, approveIntent.payload, resource),
  eventEnvelope(ActivityEventType.PrMergeRequested, mergeIntent.payload, resource),
  eventEnvelope(
    ActivityEventType.PrApproveDecisionClaimed,
    {
      action: 'approve',
      activationId: activation,
      decisionKind: 'requested',
      outcome: {
        kind: 'waiting',
        data: { intentEventId: approveIntent.eventId, signalKind: 'delivery-result' },
      },
      fact: approveIntent,
    },
    approveDecision,
  ),
  eventEnvelope(
    ActivityEventType.PrMergeDecisionClaimed,
    {
      action: 'merge',
      activationId: activation,
      decisionKind: 'requested',
      outcome: {
        kind: 'waiting',
        data: { intentEventId: mergeIntent.eventId, signalKind: 'delivery-result' },
      },
      fact: mergeIntent,
    },
    mergeDecision,
  ),
] as const;

describe('Activity event contract', () => {
  it('decodes every declared event with its exact payload and permitted stream', () => {
    expect(samples.map((event) => decodeActivityEvent(event))).toHaveLength(
      Object.keys(ActivityEventType).length,
    );
  });

  it('rejects an owned event with an unknown type', () => {
    expect(() => decodeActivityEvent(eventEnvelope('pr.unknown', {}, resource))).toThrow();
  });

  it('rejects malformed owned payloads and non-exact audit fields', () => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(ActivityEventType.PrChecksChanged, { checks: 'green' }, resource),
      ),
    ).toThrow();
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrMergeAuthorized,
          { revision: 'abc', extra: true },
          resource,
        ),
      ),
    ).toThrow();
  });

  it('rejects event-specific wrong stream kinds', () => {
    expect(() =>
      decodeActivityEvent(eventEnvelope(ActivityEventType.PrDiscovered, context, approveDecision)),
    ).toThrow();
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(ActivityEventType.PrApproveDecisionClaimed, samples[13].payload, resource),
      ),
    ).toThrow();
  });

  it('rejects an approve decision claim on a merge decision stream', () => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrApproveDecisionClaimed,
          samples[13].payload,
          mergeDecision,
        ),
      ),
    ).toThrow();
  });

  it('rejects a merge decision claim on an approve decision stream', () => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrMergeDecisionClaimed,
          samples[14].payload,
          approveDecision,
        ),
      ),
    ).toThrow();
  });

  it('selects unrelated namespaces as null but throws for any invalid owned namespace', () => {
    expect(selectActivityEvent(eventEnvelope('work.item-created', {}, resource))).toBeNull();
    expect(() => selectActivityEvent(eventEnvelope('activities.unknown', {}, resource))).toThrow(
      /event-7.*position 7.*activities\.unknown/i,
    );
    expect(() => selectActivityEvent(eventEnvelope('review.unknown', {}, resource))).toThrow();
  });
});
