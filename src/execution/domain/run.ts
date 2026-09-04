import { EventActorKind } from '@atolis-hq/eventing';
import { ExecutionEventType, type RunExecutionEvent } from '../contracts/events.js';
import type { RunView } from '../contracts/views.js';
import { ExecutionFailureCode, isActiveRunStatus, RunStatus } from '../contracts/vocabulary.js';

export function foldRun(events: readonly RunExecutionEvent[]): RunView | null {
  const creation = events[0];
  if (creation === undefined) return null;
  const creationEvent = creation.event;
  if (
    creationEvent.eventType !== ExecutionEventType.RunPreparationStarted &&
    creationEvent.eventType !== ExecutionEventType.RunStarted
  )
    throw invalidRunStream(creation.stream.id, 'first event must create the run');
  for (const event of events.slice(1))
    if (event.event.eventType === ExecutionEventType.RunPreparationStarted)
      throw invalidRunStream(creation.stream.id, 'RunPreparationStarted must be the first event');

  const startedFromPreparation =
    creationEvent.eventType === ExecutionEventType.RunPreparationStarted;
  const state: RunView = {
    runId: creation.stream.id,
    activationId: creationEvent.payload.activationId,
    activity: creationEvent.payload.activity,
    ...(creationEvent.payload.stage === undefined ? {} : { stage: creationEvent.payload.stage }),
    workflowInstanceId: creationEvent.payload.workflowInstanceId,
    orchestrationGroupId: creationEvent.payload.orchestrationGroupId,
    attempt: creationEvent.payload.attempt,
    status: startedFromPreparation ? RunStatus.Starting : RunStatus.Started,
    ambiguityAttempts: 0,
    escalated: false,
    startedAt: creationEvent.payload.startedAt,
    ...(startedFromPreparation ? {} : { executionStartedAt: creationEvent.payload.startedAt }),
    ...(creationEvent.payload.runner === undefined ? {} : { runner: creationEvent.payload.runner }),
    ...creationWorkspace(creationEvent),
  };
  for (const event of events.slice(1)) applyRunEvent(state, event.event);
  return state;
}

type RunEventData = RunExecutionEvent['event'];

function creationWorkspace(event: RunEventData): Pick<RunView, 'workspace'> {
  if (event.eventType !== ExecutionEventType.RunStarted || event.payload.workspace === undefined)
    return {};
  return { workspace: event.payload.workspace };
}

function applyRunEvent(state: RunView, event: RunEventData): void {
  if (!isActiveRunStatus(state.status)) {
    if (isOperatorAmbiguousTerminalEvent(state, event)) return applyTerminalEvent(state, event);
    return;
  }
  switch (event.eventType) {
    case ExecutionEventType.RunPreparationStarted:
      throw invalidRunStream(state.runId, 'RunPreparationStarted must be the first event');
    case ExecutionEventType.RunStarted:
      if (state.status !== RunStatus.Starting)
        throw invalidRunStream(state.runId, 'RunStarted is only valid while starting');
      validateRunStart(state, event);
      Object.assign(state, {
        status: RunStatus.Started,
        executionStartedAt: event.payload.startedAt,
        ...(event.payload.workspace === undefined ? {} : { workspace: event.payload.workspace }),
      });
      return;
    case ExecutionEventType.RunSucceeded:
    case ExecutionEventType.RunFailed:
    case ExecutionEventType.RunCancelled:
      return applyTerminalEvent(state, event);
    default:
      return applyLivenessEvent(state, event);
  }
}

function isOperatorAmbiguousTerminalEvent(
  state: RunView,
  event: RunEventData,
): event is Extract<
  RunEventData,
  {
    eventType: typeof ExecutionEventType.RunSucceeded | typeof ExecutionEventType.RunFailed;
  }
> {
  return (
    state.status === RunStatus.Ambiguous &&
    event.actor.kind === EventActorKind.Operator &&
    (event.eventType === ExecutionEventType.RunSucceeded ||
      event.eventType === ExecutionEventType.RunFailed)
  );
}

function validateRunStart(
  state: RunView,
  event: Extract<RunEventData, { eventType: typeof ExecutionEventType.RunStarted }>,
): void {
  validateRunStartField(
    state.runId,
    state.activationId,
    event.payload.activationId,
    'activationId',
  );
  validateRunStartField(state.runId, state.activity, event.payload.activity, 'activity');
  validateRunStartField(state.runId, state.stage, event.payload.stage, runStartField.Stage);
  validateRunStartField(
    state.runId,
    state.workflowInstanceId,
    event.payload.workflowInstanceId,
    'workflowInstanceId',
  );
  validateRunStartField(
    state.runId,
    state.orchestrationGroupId,
    event.payload.orchestrationGroupId,
    'orchestrationGroupId',
  );
  validateRunStartField(state.runId, state.attempt, event.payload.attempt, 'attempt');
  if (!sameRunner(state.runner, event.payload.runner))
    throw invalidRunStream(state.runId, 'RunStarted contradicts RunPreparationStarted runner');
}

const runStartFieldShape = { stage: true };
const runStartField = { Stage: Object.keys(runStartFieldShape)[0]! } as const;

function validateRunStartField(
  runId: RunView['runId'],
  actual: unknown,
  expected: unknown,
  field: string,
): void {
  if (actual !== expected)
    throw invalidRunStream(runId, `RunStarted contradicts RunPreparationStarted ${field}`);
}

function sameRunner(
  left: RunView['runner'],
  right: Extract<
    RunEventData,
    { eventType: typeof ExecutionEventType.RunStarted }
  >['payload']['runner'],
): boolean {
  return runnerFields.every((field) => left?.[field] === right?.[field]);
}

const runnerFields = ['name', 'model', 'effort', 'pool', 'cli'] as const;

function applyTerminalEvent(
  state: RunView,
  event: Extract<
    RunEventData,
    {
      eventType:
        | typeof ExecutionEventType.RunSucceeded
        | typeof ExecutionEventType.RunFailed
        | typeof ExecutionEventType.RunCancelled;
    }
  >,
): void {
  if (event.eventType === ExecutionEventType.RunSucceeded) {
    Object.assign(state, {
      status: RunStatus.Succeeded,
      finishedAt: event.payload.finishedAt,
      outcome: event.payload.outcome,
      escalated: false,
    });
    return;
  }
  if (event.eventType === ExecutionEventType.RunCancelled) {
    Object.assign(state, { status: RunStatus.Cancelled, finishedAt: event.payload.finishedAt });
    return;
  }
  Object.assign(state, {
    status: RunStatus.Failed,
    finishedAt: event.payload.finishedAt,
    failure: event.payload.failure,
    escalated: false,
  });
}

// eslint-disable-next-line complexity
function applyLivenessEvent(
  state: RunView,
  event: Exclude<
    RunEventData,
    {
      eventType:
        | typeof ExecutionEventType.RunPreparationStarted
        | typeof ExecutionEventType.RunStarted
        | typeof ExecutionEventType.RunSucceeded
        | typeof ExecutionEventType.RunFailed
        | typeof ExecutionEventType.RunCancelled;
    }
  >,
): void {
  switch (event.eventType) {
    case ExecutionEventType.RunLeaseClaimed:
    case ExecutionEventType.RunLeaseRenewed:
      Object.assign(state, { lease: event.payload });
      return;
    case ExecutionEventType.RunExternalExecutionReported:
      Object.assign(state, { externalExecution: event.payload });
      return;
    case ExecutionEventType.RunWorkspaceCleanupFailed:
      return;
    case ExecutionEventType.RunRunnerResultReported:
      Object.assign(state, event.payload.agent === undefined ? {} : { agent: event.payload.agent });
      return;
    case ExecutionEventType.RunCancellationRequested:
      Object.assign(state, { cancellation: event.payload });
      return;
    case ExecutionEventType.RunCancellationConfirmed:
      if (state.cancellation !== undefined)
        Object.assign(state, {
          cancellation: { ...state.cancellation, confirmedAt: event.payload.confirmedAt },
        });
      return;
    case ExecutionEventType.RunRecovered:
      Object.assign(
        state,
        recoveredState(event.payload.result, event.payload.finishedAt, event.payload.outcome),
      );
      return;
    case ExecutionEventType.RunAmbiguityObserved:
      Object.assign(state, {
        ambiguityAttempts: event.payload.attempt,
        failure: { kind: ExecutionFailureCode.Unexpected, message: event.payload.reason },
      });
      return;
    case ExecutionEventType.RunAmbiguous:
      Object.assign(state, {
        status: RunStatus.Ambiguous,
        finishedAt: event.payload.finishedAt,
        failure: { kind: ExecutionFailureCode.Unexpected, message: event.payload.reason },
        escalated: true,
      });
      return;
    default:
      assertNever(event);
  }
}

function recoveredState(
  result: {
    readonly transport: string;
    readonly failure?: { readonly message: string } | undefined;
  },
  finishedAt: string,
  outcome?: RunView['outcome'],
) {
  if (result.transport === RunStatus.Succeeded)
    return {
      status: RunStatus.Succeeded,
      finishedAt,
      ...(outcome === undefined ? {} : { outcome }),
    };
  if (result.transport === RunStatus.Cancelled) return { status: RunStatus.Cancelled, finishedAt };
  if (result.transport === RunStatus.Ambiguous)
    return {
      status: RunStatus.Ambiguous,
      finishedAt,
      failure: {
        kind: ExecutionFailureCode.Unexpected,
        message: result.failure?.message ?? 'Recovered execution is ambiguous',
      },
    };
  return {
    status: RunStatus.Failed,
    finishedAt,
    failure: {
      kind: ExecutionFailureCode.Unexpected,
      message: result.failure?.message ?? 'Recovered execution failed',
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Execution event: ${JSON.stringify(value)}`);
}

function invalidRunStream(runId: string, message: string): Error {
  return new Error(`Invalid Run stream ${runId}: ${message}`);
}
