import { EventActorKind } from '../../kernel/index.js';
import { ExecutionEventType, type RunExecutionEvent } from '../contracts/events.js';
import type { RunView } from '../contracts/views.js';
import { ExecutionFailureCode, isActiveRunStatus, RunStatus } from '../contracts/vocabulary.js';

export function foldRun(events: readonly RunExecutionEvent[]): RunView | null {
  const preparation = events.find(
    (event) => event.eventType === ExecutionEventType.RunPreparationStarted,
  );
  const started = events.find((event) => event.eventType === ExecutionEventType.RunStarted);
  const identity = preparation ?? started;
  if (identity === undefined) return null;
  const state: RunView = {
    runId: identity.stream.id,
    activationId: identity.payload.activationId,
    activity: identity.payload.activity,
    ...(identity.payload.stage === undefined ? {} : { stage: identity.payload.stage }),
    workflowInstanceId: identity.payload.workflowInstanceId,
    orchestrationGroupId: identity.payload.orchestrationGroupId,
    attempt: identity.payload.attempt,
    status: preparation === undefined ? RunStatus.Started : RunStatus.Starting,
    ambiguityAttempts: 0,
    escalated: false,
    startedAt: identity.payload.startedAt,
    ...(preparation === undefined ? { executionStartedAt: identity.payload.startedAt } : {}),
    ...(identity.payload.runner === undefined ? {} : { runner: identity.payload.runner }),
  };
  for (const event of events) applyRunEvent(state, event);
  return state;
}

function applyRunEvent(state: RunView, event: RunExecutionEvent): void {
  if (!isActiveRunStatus(state.status)) {
    if (
      state.status === RunStatus.Ambiguous &&
      event.actor.kind === EventActorKind.Operator &&
      (event.eventType === ExecutionEventType.RunSucceeded ||
        event.eventType === ExecutionEventType.RunFailed)
    )
      return applyTerminalEvent(state, event);
    return;
  }
  switch (event.eventType) {
    case ExecutionEventType.RunPreparationStarted:
      return;
    case ExecutionEventType.RunStarted:
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

function applyTerminalEvent(
  state: RunView,
  event: Extract<
    RunExecutionEvent,
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
    RunExecutionEvent,
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
