import { createEventDraft, type EventEnvelope, type EventJournal } from '../../kernel/index.js';
import {
  ActivityEventType,
  decodeActivityEvent,
  type ActivityFactDraft,
} from '../contracts/events.js';
import { activityDecisionStream, type PullRequestDecisionAction } from '../contracts/streams.js';
import type { ActivationId } from '../contracts/identifiers.js';
import type { PullRequestActivityOutcome } from './contracts.js';
import type { IntentAppender } from './intent.js';
import { appendResolved } from './activity-support.js';

export type PullRequestDecisionKind = 'requested' | 'denied';
export type PullRequestAction = PullRequestDecisionAction;

export interface PullRequestDecision {
  readonly decisionKind: PullRequestDecisionKind;
  readonly outcome: PullRequestActivityOutcome;
  readonly fact: ActivityFactDraft;
}

export async function readDecisionClaim(
  journal: EventJournal,
  activationId: ActivationId,
  action: PullRequestAction,
): Promise<PullRequestDecision | null> {
  const claimId = decisionClaimId(activationId, action);
  const event = (await journal.readStream(activityDecisionStream(activationId, action))).find(
    (candidate) => candidate.eventId === claimId,
  );
  return event === undefined ? null : parseClaim(event, activationId, action);
}

export async function claimDecision(
  journal: EventJournal,
  activationId: ActivationId,
  action: PullRequestAction,
  proposal: PullRequestDecision,
): Promise<PullRequestDecision> {
  const existing = await readDecisionClaim(journal, activationId, action);
  if (existing !== null) return existing;

  const stream = activityDecisionStream(activationId, action);
  const claim = createEventDraft({
    eventId: decisionClaimId(activationId, action),
    eventType: decisionEventType(action),
    occurredAt: proposal.fact.occurredAt,
    correlationId: proposal.fact.correlationId,
    causationId: proposal.fact.causationId,
    actor: proposal.fact.actor,
    source: { kind: 'internal', id: 'activities-pr' },
    stream,
    payload: {
      action,
      activationId,
      decisionKind: proposal.decisionKind,
      outcome: proposal.outcome,
      fact: proposal.fact,
    },
  });

  try {
    await journal.append(stream, 0, [claim]);
    return proposal;
  } catch (error) {
    const winner = await readDecisionClaim(journal, activationId, action);
    if (winner !== null) return winner;
    throw error;
  }
}

export async function completeDecisionClaim(
  journal: EventJournal,
  appender: IntentAppender,
  decision: PullRequestDecision,
): Promise<PullRequestActivityOutcome> {
  const result = await appendResolved(journal, appender, decision.fact.stream, decision.fact);
  return result === 'failed'
    ? { kind: 'failed', data: { reason: 'intent-write-failed' } }
    : decision.outcome;
}

function decisionClaimId(activationId: ActivationId, action: PullRequestAction): string {
  return `${activationId}:${decisionEventType(action)}`;
}

function parseClaim(
  event: EventEnvelope,
  activationId: ActivationId,
  action: PullRequestAction,
): PullRequestDecision {
  const decoded = decodeActivityEvent(event);
  const expectedType = decisionEventType(action);
  if (
    decoded.eventType !== expectedType ||
    decoded.payload.activationId !== activationId ||
    decoded.payload.action !== action
  ) {
    throw new Error(`Invalid pull-request decision claim ${event.eventId}`);
  }
  return {
    decisionKind: decoded.payload.decisionKind,
    outcome: decoded.payload.outcome,
    fact: decoded.payload.fact,
  };
}

function decisionEventType(
  action: PullRequestAction,
):
  | typeof ActivityEventType.PrApproveDecisionClaimed
  | typeof ActivityEventType.PrMergeDecisionClaimed {
  return action === 'approve'
    ? ActivityEventType.PrApproveDecisionClaimed
    : ActivityEventType.PrMergeDecisionClaimed;
}
