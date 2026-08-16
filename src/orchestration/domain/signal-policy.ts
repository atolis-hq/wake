import { ActivityOutcomeKind } from '../../activities/index.js';
import type {
  OrchestrationActivityOutcome,
  OrchestrationWaitingActivityOutcome,
} from '../contracts/activity-outcome.js';
import type { ApprovalAuthority, CompiledWorkflow } from '../contracts/config.js';
import type {
  OrchestrationSignal,
  SignalExpectation,
  WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  ActivityActivationStatus,
  ApprovalAuthorityKind,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import type {
  AcceptActivityOutcome,
  DecisionContext,
  OrchestrationDecision,
} from './activation-policy.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';
import { resumeToTarget } from './transition.js';

export interface AcceptSignal extends DecisionContext {
  readonly signal: OrchestrationSignal;
  // Does the WorkItem carry operator consent for `auto` authority? Defaults to false.
  readonly consent?: boolean;
}

export function waitForSignal(
  state: WorkflowInstanceView,
  expectation: SignalExpectation,
  input: DecisionContext,
): OrchestrationDecision {
  if (state.status !== WorkflowStatus.Waiting && state.status !== WorkflowStatus.Blocked)
    return { kind: 'ignored', reason: 'WorkflowInstance is not waiting or blocked' };
  if (expectation.signalKind.trim().length === 0)
    return { kind: 'ignored', reason: 'signal kind must not be empty' };
  return {
    kind: 'append',
    events: [stateDraft(state, input, OrchestrationEventType.SignalWaitStarted, expectation, 1)],
  };
}

export function acceptSignal(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptSignal,
): OrchestrationDecision {
  const rejection = signalRejectionReason(state, input);
  if (rejection !== null) return { kind: 'ignored', reason: rejection };

  const signal = input.signal;
  const expected = state.waitingFor!;
  const authority = signal.authority ?? { kind: ApprovalAuthorityKind.Human };
  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(state, input, OrchestrationEventType.SignalAccepted, { ...signal, authority }, 1),
  ];
  const target =
    signal.outcome === ActivityOutcomeKind.Rejected ? expected.onRejectResume : expected.resume;
  if (target !== undefined) resumeToTarget(events, definition, state, input, target);
  else requestLegacyReentry(events, definition, state, input);
  return { kind: 'append', events };
}

function requestLegacyReentry(
  events: WorkflowOrchestrationEventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: DecisionContext,
): void {
  const stage = definition.stages[stageName(state.currentStage)]!;
  events.push(
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
        stage: stageName(state.currentStage),
      }),
      events.length + 1,
    ),
  );
}

function signalRejectionReason(state: WorkflowInstanceView, input: AcceptSignal): string | null {
  const signal = input.signal;
  if (state.acceptedSignalIds.includes(signal.providerEventId))
    return 'provider signal was already accepted';
  const expected = state.waitingFor;
  if (expected === undefined) return 'WorkflowInstance is not waiting for a signal';
  if (
    state.status !== WorkflowStatus.Waiting &&
    !isBlockedHumanAuthorizedWait(state, signal, expected)
  )
    return 'WorkflowInstance is not waiting for a signal';
  if (!matchesExpectation(signal, expected)) return 'signal does not match the current expectation';
  if (!hasDecisionEvidence(signal)) return 'signal lacks authorized actor decision evidence';
  if (signal.providerEventId.trim().length === 0) return 'signal lacks provider event identity';
  if (!signalAuthorityAccepted(signal, expected, input.consent ?? false))
    return 'signal authority is not accepted by this wait';
  if (!watchGateOutcomeAccepted(signal, expected))
    return 'watch-gate signal outcome is neither done nor rejected';
  return null;
}

function isBlockedHumanAuthorizedWait(
  state: WorkflowInstanceView,
  signal: OrchestrationSignal,
  expected: NonNullable<WorkflowInstanceView['waitingFor']>,
): boolean {
  return (
    state.status === WorkflowStatus.Blocked &&
    signal.authority?.kind === ApprovalAuthorityKind.Human &&
    expected.from?.some((authority) => authority.kind === ApprovalAuthorityKind.Human) === true
  );
}

function signalAuthorityAccepted(
  signal: OrchestrationSignal,
  expected: NonNullable<WorkflowInstanceView['waitingFor']>,
  consent: boolean,
): boolean {
  if (expected.from === undefined) return true;
  const authority = signal.authority ?? { kind: ApprovalAuthorityKind.Human };
  return authorityAccepted(authority, expected.from, consent);
}

function watchGateOutcomeAccepted(
  signal: OrchestrationSignal,
  expected: NonNullable<WorkflowInstanceView['waitingFor']>,
): boolean {
  return (
    expected.onRejectResume === undefined ||
    signal.outcome === undefined ||
    signal.outcome === ActivityOutcomeKind.Done ||
    signal.outcome === ActivityOutcomeKind.Rejected
  );
}

function authorityAccepted(
  authority: ApprovalAuthority,
  declared: readonly ApprovalAuthority[],
  consent: boolean,
): boolean {
  switch (authority.kind) {
    case ApprovalAuthorityKind.Human:
      return declared.some((entry) => entry.kind === ApprovalAuthorityKind.Human);
    case ApprovalAuthorityKind.Auto:
      return consent && declared.some((entry) => entry.kind === ApprovalAuthorityKind.Auto);
    case ApprovalAuthorityKind.Watch:
      return declared.some(
        (entry) => entry.kind === ApprovalAuthorityKind.Watch && entry.watch === authority.watch,
      );
    default:
      return false;
  }
}

export function acceptWaitingOutcome(
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): OrchestrationDecision {
  const waiting = waitingOutcome(input.outcome);
  if (waiting === null) return { kind: 'ignored', reason: 'waiting outcome lacks expectation' };
  if (
    state.pendingActivation?.status === ActivityActivationStatus.Waiting &&
    state.waitingFor?.intentEventId === waiting.data.intentEventId &&
    state.waitingFor.signalKind === waiting.data.signalKind
  )
    return { kind: 'ignored', reason: 'waiting outcome was already recorded' };
  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityWaiting,
      { activationId: input.activationId, outcome: waiting },
      1,
    ),
  ];
  return { kind: 'append', events };
}

function matchesExpectation(
  signal: OrchestrationSignal,
  expected: WorkflowInstanceView['waitingFor'],
): boolean {
  return (
    signal.kind === expected?.signalKind &&
    signal.resourceId === expected.resourceId &&
    signal.revision === expected.revision
  );
}

function hasDecisionEvidence(signal: OrchestrationSignal): boolean {
  return (
    signal.actorId.trim().length > 0 &&
    signal.actorDecision.authorized &&
    signal.actorDecision.evidenceId.trim().length > 0
  );
}

function waitingOutcome(
  outcome: OrchestrationActivityOutcome,
): OrchestrationWaitingActivityOutcome | null {
  return outcome.kind === ActivityOutcomeKind.Waiting
    ? (outcome as OrchestrationWaitingActivityOutcome)
    : null;
}
