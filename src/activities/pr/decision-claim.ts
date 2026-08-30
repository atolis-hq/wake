import { EventSourceKind, type EventEnvelope, type EventJournal } from '../../kernel/index.js';
import { createActivityEventData } from '../contracts/event-factory.js';
import {
  ActivityEventType,
  decodeActivityEvent,
  decodeActivityEventData,
  type ActivityEventPayloads,
} from '../contracts/events.js';
import type { ActivationId } from '../contracts/identifiers.js';
import { activityDecisionStream, type PullRequestDecisionAction } from '../contracts/streams.js';
import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  IntentAppendStatus,
} from '../contracts/vocabulary.js';
import { appendResolved } from './activity-support.js';
import type { PullRequestActivityOutcome } from './contracts.js';
import type { IntentAppender } from './intent.js';

type PullRequestDecisionKind = 'requested' | 'denied';

export type PullRequestAction = PullRequestDecisionAction;

type DecisionClaimPayload<Action extends PullRequestAction> = Action extends 'approve'
  ? ActivityEventPayloads[typeof ActivityEventType.PrApproveDecisionClaimed]
  : ActivityEventPayloads[typeof ActivityEventType.PrMergeDecisionClaimed];

type DecisionFromClaim<Claim> = Claim extends {
  readonly decisionKind: infer Kind extends PullRequestDecisionKind;
  readonly outcome: infer Outcome extends PullRequestActivityOutcome;
  readonly fact: infer Fact;
  readonly factStream: infer FactStream;
}
  ? {
      readonly decisionKind: Kind;
      readonly outcome: Outcome;
      readonly fact: Fact;
      readonly factStream: FactStream;
    }
  : never;

export type PullRequestDecision<Action extends PullRequestAction = PullRequestAction> =
  DecisionFromClaim<DecisionClaimPayload<Action>>;

export async function readDecisionClaim<Action extends PullRequestAction>(
  journal: EventJournal,
  activationId: ActivationId,
  action: Action,
): Promise<PullRequestDecision<Action> | null> {
  const claimId = decisionClaimId(activationId, action);
  const event = (await journal.readStream(activityDecisionStream(activationId, action))).find(
    (candidate) => candidate.event.eventId === claimId,
  );
  return event === undefined ? null : parseClaim(event, activationId, action);
}

export async function claimDecision<Action extends PullRequestAction>(
  journal: EventJournal,
  activationId: ActivationId,
  action: Action,
  proposal: PullRequestDecision<NoInfer<Action>>,
): Promise<PullRequestDecision<Action>> {
  const existing = await readDecisionClaim(journal, activationId, action);
  if (existing !== null) return existing;

  const stream = activityDecisionStream(activationId, action);
  const claim = createActivityEventData({
    eventId: decisionClaimId(activationId, action),
    eventType: decisionEventType(action),
    occurredAt: proposal.fact.occurredAt,
    correlationId: proposal.fact.correlationId,
    causationId: proposal.fact.causationId,
    actor: proposal.fact.actor,
    source: { kind: EventSourceKind.Internal, id: 'activities-pr' },
    payload: {
      action,
      activationId,
      decisionKind: proposal.decisionKind,
      outcome: proposal.outcome,
      fact: proposal.fact,
      factStream: proposal.factStream,
    },
  });
  decodeActivityEventData(claim);

  try {
    await journal.appendToStream(stream, 0, [claim]);
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
  const result = await appendResolved(journal, appender, decision.factStream, decision.fact);
  return result === IntentAppendStatus.Failed
    ? { kind: ActivityOutcomeKind.Failed, data: { reason: ActivityFailureCode.IntentWriteFailed } }
    : decision.outcome;
}

export async function claimAndCompleteDecision<Action extends PullRequestAction>(
  journal: EventJournal,
  appender: IntentAppender,
  activationId: ActivationId,
  action: Action,
  proposal: PullRequestDecision<NoInfer<Action>>,
): Promise<PullRequestActivityOutcome> {
  const claimed = await claimDecision(journal, activationId, action, proposal);
  return completeDecisionClaim(journal, appender, claimed);
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
    decoded.event.eventType !== expectedType ||
    decoded.event.payload.activationId !== activationId ||
    decoded.event.payload.action !== action
  ) {
    throw new Error(`Invalid pull-request decision claim ${event.event.eventId}`);
  }
  return {
    decisionKind: decoded.event.payload.decisionKind,
    outcome: decoded.event.payload.outcome,
    fact: decoded.event.payload.fact,
    factStream: decoded.event.payload.factStream,
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
