import { createEventData, type EventJournal } from '@atolis-hq/eventing';
import { InProcessJournalChangeSignal } from '@atolis-hq/eventing/memory';
import { expect, expectTypeOf, it } from 'vitest';
import {
  activationId,
  ActivityEventType,
  decodeActivityEventData,
  type ActivityFactEventData,
} from '../../../src/activities/index.js';
import type { PullRequestActivityOutcome } from '../../../src/activities/pr/contracts.js';
import {
  claimDecision,
  type PullRequestDecision,
} from '../../../src/activities/pr/decision-claim.js';
import { signalName } from '../../../src/orchestration/contracts/identifiers.js';
import { resourceStream } from '../../../src/resources/index.js';
import { resId } from '../../support/identities.js';

type Fact<Type extends ActivityFactEventData['eventType']> = Extract<
  ActivityFactEventData,
  { eventType: Type }
>;

type Outcome<Kind extends PullRequestActivityOutcome['kind']> = Extract<
  PullRequestActivityOutcome,
  { kind: Kind }
>;

it('maps action and decision kind to the exact canonical fact type', () => {
  type ApproveRequested = Extract<PullRequestDecision<'approve'>, { decisionKind: 'requested' }>;

  type ApproveDenied = Extract<PullRequestDecision<'approve'>, { decisionKind: 'denied' }>;

  type MergeRequested = Extract<PullRequestDecision<'merge'>, { decisionKind: 'requested' }>;

  type MergeDenied = Extract<PullRequestDecision<'merge'>, { decisionKind: 'denied' }>;

  expectTypeOf<ApproveRequested['fact']>().toEqualTypeOf<
    Fact<typeof ActivityEventType.PrApproveRequested>
  >();
  expectTypeOf<ApproveRequested['outcome']>().toEqualTypeOf<Outcome<'waiting'>>();
  expectTypeOf<ApproveDenied['fact']>().toEqualTypeOf<
    Fact<typeof ActivityEventType.PrApproveDenied>
  >();
  expectTypeOf<ApproveDenied['outcome']>().toEqualTypeOf<Outcome<'blocked'>>();
  expectTypeOf<MergeRequested['fact']>().toEqualTypeOf<
    Fact<typeof ActivityEventType.PrMergeRequested>
  >();
  expectTypeOf<MergeRequested['outcome']>().toEqualTypeOf<Outcome<'waiting'>>();
  expectTypeOf<MergeDenied['fact']>().toEqualTypeOf<Fact<typeof ActivityEventType.PrMergeDenied>>();
  expectTypeOf<MergeDenied['outcome']>().toEqualTypeOf<Outcome<'blocked'>>();
});

it('rejects a malformed outcome/fact pair through the event data decoder context', () => {
  const activation = activationId('activation-1');
  const stream = resourceStream(resId('1'));
  const approveRequest = createEventData({
    eventId: 'approve-request',
    eventType: ActivityEventType.PrApproveRequested,
    occurredAt: '2026-07-31T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'causation-1',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'activities-pr' },
    payload: {
      idempotencyKey: 'approve-request',
      activationId: activation,
      resourceId: stream.id,
      revision: 'abc',
      body: null,
    },
  });
  const malformedClaim = createEventData({
    eventId: 'approve-claim',
    eventType: ActivityEventType.PrApproveDecisionClaimed,
    occurredAt: approveRequest.occurredAt,
    correlationId: approveRequest.correlationId,
    causationId: approveRequest.causationId,
    actor: approveRequest.actor,
    source: { kind: 'internal', id: 'activities-pr' },
    payload: {
      action: 'approve',
      activationId: activation,
      decisionKind: 'requested',
      outcome: { kind: 'blocked', data: { reason: 'policy' } },
      fact: approveRequest,
      factStream: stream,
    },
  });

  expect(() => decodeActivityEventData(malformedClaim)).toThrow(
    /Invalid Activity event data approve-claim/i,
  );
});

it('rejects an inexact decision claim before calling the journal append boundary', async () => {
  let appends = 0;
  const journal: EventJournal = {
    async appendToStream() {
      appends += 1;
      return [];
    },
    async readStream() {
      return [];
    },
    async readAll() {
      return [];
    },
    async latestGlobalPosition() {
      return 0;
    },
    async waitForEventsAfter() {},
    changeSignal: new InProcessJournalChangeSignal(),
  };
  const activation = activationId('activation-1');
  const stream = resourceStream(resId('1'));
  const mergeRequest = createEventData({
    eventId: 'merge-request',
    eventType: ActivityEventType.PrMergeRequested,
    occurredAt: '2026-07-31T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'causation-1',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'activities-pr' },
    payload: {
      idempotencyKey: 'merge-request',
      activationId: activation,
      resourceId: stream.id,
      revision: 'abc',
      method: 'merge',
      requireChecks: true,
    },
  });
  const invalidProposal = {
    decisionKind: 'requested',
    outcome: {
      kind: 'waiting',
      data: { intentEventId: mergeRequest.eventId, signalKind: signalName('delivery-result') },
    },
    fact: mergeRequest,
    factStream: stream,
  } as unknown as PullRequestDecision<'approve'>;

  await expect(claimDecision(journal, activation, 'approve', invalidProposal)).rejects.toThrow(
    /Invalid Activity event data/i,
  );
  expect(appends).toBe(0);
});
