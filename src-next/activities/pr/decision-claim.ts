import {
  createEventDraft,
  type EventDraft,
  type EventEnvelope,
  type EventJournal,
} from '../../kernel/index.js';
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
  readonly fact: EventDraft;
}

interface DecisionClaimPayload extends PullRequestDecision {
  readonly action: PullRequestAction;
  readonly activationId: ActivationId;
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
    eventType: `pr.${action}-decision-claimed`,
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
    } satisfies DecisionClaimPayload,
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
  return `${activationId}:pr.${action}-decision-claimed`;
}

function parseClaim(
  event: EventEnvelope,
  activationId: ActivationId,
  action: PullRequestAction,
): PullRequestDecision {
  const payload = event.payload;
  if (
    !isRecord(payload) ||
    payload.activationId !== activationId ||
    payload.action !== action ||
    (payload.decisionKind !== 'requested' && payload.decisionKind !== 'denied') ||
    !isOutcome(payload.outcome) ||
    !isEventDraft(payload.fact)
  ) {
    throw new Error(`Invalid pull-request decision claim ${event.eventId}`);
  }
  return {
    decisionKind: payload.decisionKind,
    outcome: payload.outcome,
    fact: payload.fact,
  };
}

function isOutcome(value: unknown): value is PullRequestActivityOutcome {
  if (!isRecord(value) || typeof value.kind !== 'string' || !isRecord(value.data)) return false;
  if (value.kind === 'waiting')
    return (
      typeof value.data.intentEventId === 'string' && value.data.signalKind === 'delivery-result'
    );
  if (value.kind === 'done') return typeof value.data.deliveryEventId === 'string';
  if (value.kind === 'blocked' || value.kind === 'failed')
    return typeof value.data.reason === 'string';
  return false;
}

function isEventDraft(value: unknown): value is EventDraft {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.eventType === 'string' &&
    value.schemaVersion === 1 &&
    typeof value.occurredAt === 'string' &&
    typeof value.correlationId === 'string' &&
    typeof value.causationId === 'string' &&
    isRecord(value.actor) &&
    isRecord(value.source) &&
    isRecord(value.stream)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
