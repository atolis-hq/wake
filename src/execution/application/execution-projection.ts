import type { ProjectionDefinition } from '../../kernel/index.js';
import {
  ExecutionEventType,
  selectRunExecutionEvent,
  type RunExecutionEvent,
} from '../contracts/events.js';
import type { RunView } from '../contracts/views.js';
import { foldRun } from '../domain/run.js';

type ProjectionValue = {
  readonly events: readonly RunExecutionEvent[];
  readonly view: RunView | null;
};

export const executionProjection: ProjectionDefinition<ProjectionValue> = {
  name: 'execution',
  select(event) {
    const owned = selectRunExecutionEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => ({ events: [], view: null }),
  project(previous, event) {
    const owned = selectRunExecutionEvent(event);
    if (owned === null) return previous;
    const events = [...previous.events, owned];
    return { events, view: foldRun(events) };
  },
};

/** Run membership keyed by workflow instance for scoped readers. */
export const runsByWorkflowInstanceProjection: ProjectionDefinition<readonly RunView['runId'][]> = {
  name: 'runs-by-workflow-instance',
  select(event) {
    const owned = selectRunExecutionEvent(event);
    return owned?.eventType === ExecutionEventType.RunStarted
      ? { key: owned.payload.workflowInstanceId }
      : null;
  },
  initial: () => [],
  project(previous, event) {
    const owned = selectRunExecutionEvent(event);
    if (owned?.eventType !== ExecutionEventType.RunStarted) return previous;
    return previous.includes(owned.stream.id) ? previous : [...previous, owned.stream.id];
  },
};
