import type { EventEnvelope } from '../../kernel/index.js';
import type { RunView } from '../contracts/views.js';
export function foldRun(events: readonly EventEnvelope[]): RunView | null {
  const started = events.find((event) => event.eventType === 'execution.run-started');
  if (started === undefined || !record(started.payload)) return null;
  const workspace = record(started.payload.workspace)
    ? (started.payload.workspace as {
        readonly mode: 'read-only' | 'branch';
        readonly path: string;
      })
    : undefined;
  const state: RunView = {
    runId: started.stream.id,
    activationId: String(started.payload.activationId),
    activity: String(started.payload.activity),
    attempt: Number(started.payload.attempt),
    status: 'started',
    startedAt: String(started.payload.startedAt),
    ...(workspace === undefined ? {} : { workspace }),
  };
  for (const event of events) {
    if (!record(event.payload)) continue;
    if (event.eventType === 'execution.run-succeeded')
      Object.assign(state, {
        status: 'succeeded',
        finishedAt: event.payload.finishedAt,
        outcome: event.payload.outcome,
      });
    if (event.eventType === 'execution.run-failed')
      Object.assign(state, {
        status: 'failed',
        finishedAt: event.payload.finishedAt,
        failure: event.payload.failure,
      });
  }
  return state;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
