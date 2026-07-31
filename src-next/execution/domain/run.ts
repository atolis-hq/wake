import { RunStatus } from '../contracts/vocabulary.js';
import { ExecutionEventType, type ExecutionEvent } from '../contracts/events.js';
import type { RunView } from '../contracts/views.js';
export function foldRun(events: readonly ExecutionEvent[]): RunView | null {
  const started = events.find((event) => event.eventType === ExecutionEventType.RunStarted);
  if (started === undefined) return null;
  const state: RunView = {
    runId: started.stream.id,
    activationId: started.payload.activationId,
    activity: started.payload.activity,
    attempt: started.payload.attempt,
    status: RunStatus.Started,
    startedAt: started.payload.startedAt,
    ...(started.payload.workspace === undefined ? {} : { workspace: started.payload.workspace }),
  };
  for (const event of events) {
    switch (event.eventType) {
      case ExecutionEventType.RunStarted:
        break;
      case ExecutionEventType.RunSucceeded:
        Object.assign(state, {
          status: RunStatus.Succeeded,
          finishedAt: event.payload.finishedAt,
          outcome: event.payload.outcome,
        });
        break;
      case ExecutionEventType.RunFailed:
        Object.assign(state, {
          status: RunStatus.Failed,
          finishedAt: event.payload.finishedAt,
          failure: event.payload.failure,
        });
        break;
      default:
        assertNever(event);
    }
  }
  return state;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Execution event: ${JSON.stringify(value)}`);
}
