import type { EventEnvelope, ProjectionDefinition } from '../../kernel/index.js';
import { foldWorkflowInstance } from '../domain/workflow-instance.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
type ProjectionValue = {
  readonly events: readonly EventEnvelope[];
  readonly view: WorkflowInstanceView | null;
};
export const orchestrationProjection: ProjectionDefinition<ProjectionValue> = {
  name: 'orchestration',
  select: (event) => (event.stream.kind === 'workflow-instance' ? { key: event.stream.id } : null),
  initial: () => ({ events: [], view: null }),
  project(previous, event) {
    const events = [...previous.events, event];
    return { events, view: foldWorkflowInstance(events) };
  },
};
