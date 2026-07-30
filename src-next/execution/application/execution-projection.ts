import type { EventEnvelope, ProjectionDefinition } from '../../kernel/index.js';
import { foldRun } from '../domain/run.js';
import type { RunView } from '../contracts/views.js';
type ProjectionValue = { readonly events: readonly EventEnvelope[]; readonly view: RunView | null };
export const executionProjection: ProjectionDefinition<ProjectionValue> = {
  name: 'execution',
  select: (event) => (event.stream.kind === 'run' ? { key: event.stream.id } : null),
  initial: () => ({ events: [], view: null }),
  project(previous, event) {
    const events = [...previous.events, event];
    return { events, view: foldRun(events) };
  },
};
