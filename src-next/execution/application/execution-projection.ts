import type { ProjectionDefinition } from '../../kernel/index.js';
import { selectRunExecutionEvent, type RunExecutionEvent } from '../contracts/events.js';
import { foldRun } from '../domain/run.js';
import type { RunView } from '../contracts/views.js';
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
