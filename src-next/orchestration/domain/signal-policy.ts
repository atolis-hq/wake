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
  const signal = input.signal;
  if (state.acceptedSignalIds.includes(signal.providerEventId))
    return { kind: 'ignored', reason: 'provider signal was already accepted' };
  const expected = state.waitingFor;
  if (state.status !== WorkflowStatus.Waiting || expected === undefined)
    return { kind: 'ignored', reason: 'WorkflowInstance is not waiting for a signal' };
  if (!matchesExpectation(signal, expected))
    return { kind: 'ignored', reason: 'signal does not match the current expectation' };
  if (!hasDecisionEvidence(signal))
    return { kind: 'ignored', reason: 'signal lacks authorized actor decision evidence' };
  if (signal.providerEventId.trim().length === 0)
    return { kind: 'ignored', reason: 'signal lacks provider event identity' };
  const authority = signal.authority ?? { kind: ApprovalAuthorityKind.Human };
  if (
    expected.from !== undefined &&
    !authorityAccepted(authority, expected.from, input.consent ?? false)
  )
    return { kind: 'ignored', reason: 'signal authority is not accepted by this wait' };

  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(state, input, OrchestrationEventType.SignalAccepted, { ...signal, authority }, 1),
  ];
  if (expected.resume !== undefined) {
    resumeToTarget(events, definition, state, input, expected.resume);
  } else {
    const stage = definition.stages[stageName(state.currentStage)]!;
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.ActivityRequested,
        activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
          execution: stage.execution,
        }),
        events.length + 1,
      ),
    );
  }
  return { kind: 'append', events };
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
