import { createEventDraft, type EventEnvelope, type EventJournal } from '../../kernel/index.js';
import {
  ActivityEventType,
  decodeActivityEvent,
  decodeActivityEventDraft,
  type ActivityFactDraft,
} from '../contracts/events.js';
import { activityDecisionStream, type PullRequestDecisionAction } from '../contracts/streams.js';
import type { ActivationId } from '../contracts/identifiers.js';
import type { PullRequestActivityOutcome } from './contracts.js';
import type { IntentAppender } from './intent.js';
import { appendResolved } from './activity-support.js';

export type PullRequestDecisionKind = 'requested' | 'denied';
export type PullRequestAction = PullRequestDecisionAction;

type DecisionFactType<
  Action extends PullRequestAction,
  Kind extends PullRequestDecisionKind,
> = Action extends 'approve'
  ? Kind extends 'requested'
    ? typeof ActivityEventType.PrApproveRequested
    : typeof ActivityEventType.PrApproveDenied
  : Kind extends 'requested'
    ? typeof ActivityEventType.PrMergeRequested
    : typeof ActivityEventType.PrMergeDenied;

type DecisionFact<Action extends PullRequestAction, Kind extends PullRequestDecisionKind> = Extract<
  ActivityFactDraft,
  { eventType: DecisionFactType<Action, Kind> }
>;

export type PullRequestDecision<Action extends PullRequestAction = PullRequestAction> = {
  readonly [Kind in PullRequestDecisionKind]: {
    readonly decisionKind: Kind;
    readonly outcome: PullRequestActivityOutcome;
    readonly fact: DecisionFact<Action, Kind>;
  };
}[PullRequestDecisionKind];

export async function readDecisionClaim<Action extends PullRequestAction>(
  journal: EventJournal,
  activationId: ActivationId,
  action: Action,
): Promise<PullRequestDecision<Action> | null> {
  const claimId = decisionClaimId(activationId, action);
  const event = (await journal.readStream(activityDecisionStream(activationId, action))).find(
    (candidate) => candidate.eventId === claimId,
  );
  return event === undefined ? null : parseClaim(event, activationId, action);
}

export async function claimDecision<Action extends PullRequestAction>(
  journal: EventJournal,
  activationId: ActivationId,
  action: Action,
  proposal: PullRequestDecision<Action>,
): Promise<PullRequestDecision<Action>> {
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
  decodeActivityEventDraft(claim);

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

function parseClaim<Action extends PullRequestAction>(
  event: EventEnvelope,
  activationId: ActivationId,
  action: Action,
): PullRequestDecision<Action> {
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
  } as PullRequestDecision<Action>;
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
