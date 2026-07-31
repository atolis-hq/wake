import type { ProjectionDefinition } from '../../kernel/index.js';
import { selectExecutionEvent, type ExecutionEvent } from '../contracts/events.js';
import { foldRun } from '../domain/run.js';
import type { RunView } from '../contracts/views.js';
type ProjectionValue = {
  readonly events: readonly ExecutionEvent[];
  readonly view: RunView | null;
};
export const executionProjection: ProjectionDefinition<ProjectionValue> = {
  name: 'execution',
  select(event) {
    const owned = selectExecutionEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => ({ events: [], view: null }),
  project(previous, event) {
    const owned = selectExecutionEvent(event);
    if (owned === null) return previous;
    const events = [...previous.events, owned];
    return { events, view: foldRun(events) };
  },
};
