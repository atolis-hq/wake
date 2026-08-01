import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  activationId,
  activityDecisionStream,
  type ActivityEvent,
  ActivityEventType,
  decodeActivityEvent,
  type PullRequestDenialCode,
  selectActivityEvent,
} from '../../src-next/activities/index.js';
import { createEventDraft } from '../../src-next/kernel/index.js';
import { signalName } from '../../src-next/orchestration/contracts/identifiers.js';
import { resourceStream } from '../../src-next/resources/index.js';
import { workItemStream } from '../../src-next/work/index.js';
import { eventEnvelope } from '../support/event-envelope.js';
import { resId, workId } from '../support/identities.js';

const resource = resourceStream(resId('1'));
const work = workItemStream(workId('1'));
const activation = activationId('activation-1');
const approveDecision = activityDecisionStream(activation, 'approve');
const mergeDecision = activityDecisionStream(activation, 'merge');
const context = {
  workItemId: workId('1'),
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
    workflowInstanceId: 'workflow-1',
    resourceId: resId('1'),
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
    workflowInstanceId: 'workflow-1',
    resourceId: resId('1'),
    revision: 'abc',
    method: 'squash',
    requireChecks: true,
  },
});
const approveDenial = createEventDraft({
  ...approveIntent,
  eventId: 'approve-denied',
  eventType: ActivityEventType.PrApproveDenied,
  payload: {
    activationId: activation,
    idempotencyKey: 'approve-denied',
    reason: 'policy',
    resourceId: resource.id,
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
      resourceId: resId('1'),
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
        data: { intentEventId: approveIntent.eventId, signalKind: signalName('delivery-result') },
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
        data: { intentEventId: mergeIntent.eventId, signalKind: signalName('delivery-result') },
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

  it('closes review rejection reasons to Pull Request denial codes', () => {
    type ReviewRejected = Extract<
      ActivityEvent,
      { readonly eventType: typeof ActivityEventType.PrReviewRejected }
    >;

    expectTypeOf<ReviewRejected['payload']['reason']>().toEqualTypeOf<PullRequestDenialCode>();
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrReviewRejected,
          { reason: 'unknown-rejection' },
          resource,
        ),
      ),
    ).toThrow();
  });

  it('does not publish the unused ActivityActivated contract', async () => {
    const source = await readFile(
      new URL('../../src-next/activities/contracts/events.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/export interface ActivityActivated/);
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

describe('Activity event integrity', () => {
  it.each([
    eventEnvelope(
      ActivityEventType.PrDiscovered,
      { ...context, workItemId: 'invalid-work-id' },
      resource,
    ),
    eventEnvelope(
      ActivityEventType.PrApproveDecisionClaimed,
      { ...samples[13].payload, activationId: ' ' },
      approveDecision,
    ),
  ])('reports invalid branded IDs through the Activity decoder context', (event) => {
    expect(() => decodeActivityEvent(event)).toThrow(
      /Invalid Activity event event-7 at global position 7/i,
    );
  });

  it('rejects an Activity resource payload whose id does not identify its stream', () => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrApproveRequested,
          { ...approveIntent.payload, resourceId: resId('2') },
          resource,
        ),
      ),
    ).toThrow();
  });

  it('rejects a decision claim whose activation does not identify its stream', () => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrApproveDecisionClaimed,
          { ...samples[13].payload, activationId: activationId('activation-2') },
          approveDecision,
        ),
      ),
    ).toThrow();
  });
});

describe('Activity decision claim integrity', () => {
  it.each([
    {
      name: 'requested claim with a blocked outcome',
      payload: {
        ...samples[13].payload,
        outcome: { kind: 'blocked', data: { reason: 'policy' } },
      },
    },
    {
      name: 'requested claim with a mismatched intent event id',
      payload: {
        ...samples[13].payload,
        outcome: {
          kind: 'waiting',
          data: { intentEventId: 'other-intent', signalKind: signalName('delivery-result') },
        },
      },
    },
    {
      name: 'denied claim with a waiting outcome',
      payload: {
        ...samples[13].payload,
        decisionKind: 'denied',
        outcome: {
          kind: 'waiting',
          data: { intentEventId: approveDenial.eventId, signalKind: signalName('delivery-result') },
        },
        fact: approveDenial,
      },
    },
  ])('rejects $name with Activity event context', ({ payload }) => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(ActivityEventType.PrApproveDecisionClaimed, payload, approveDecision),
      ),
    ).toThrow(/Invalid Activity event event-7 at global position 7/i);
  });

  it('reports a lone-surrogate activation id through the Activity decoder context', () => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrApproveDecisionClaimed,
          { ...samples[13].payload, activationId: '\uD800' },
          approveDecision,
        ),
      ),
    ).toThrow(/Invalid Activity event event-7 at global position 7/i);
  });

  it.each([
    { decisionKind: 'denied', fact: approveIntent },
    {
      decisionKind: 'requested',
      fact: approveDenial,
    },
  ] as const)('rejects a decision kind paired with the wrong fact family', (mismatch) => {
    expect(() =>
      decodeActivityEvent(
        eventEnvelope(
          ActivityEventType.PrApproveDecisionClaimed,
          { ...samples[13].payload, ...mismatch },
          approveDecision,
        ),
      ),
    ).toThrow();
  });
});
