import type { ProjectionDefinition } from '../../kernel/index.js';
import { selectWorkflowOrchestrationEvent } from '../contracts/event-decoder.js';
import { type WorkflowOrchestrationEvent } from '../contracts/events.js';
import { isWorkflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { foldWorkflowInstance } from '../domain/workflow-instance.js';

type ProjectionValue = {
  readonly events: readonly WorkflowOrchestrationEvent[];
  readonly view: WorkflowInstanceView | null;
};

export const orchestrationProjection: ProjectionDefinition<ProjectionValue> = {
  name: 'orchestration',
  select(event) {
    const owned = selectWorkflowOrchestrationEvent(event);
    return owned !== null && isWorkflowInstanceStream(owned.stream)
      ? { key: owned.stream.id }
      : null;
  },
  initial: () => ({ events: [], view: null }),
  project(previous, event) {
    const owned = selectWorkflowOrchestrationEvent(event);
    if (owned === null || !isWorkflowInstanceStream(owned.stream)) return previous;
    const events = [...previous.events, owned];
    return { events, view: foldWorkflowInstance(events) };
  },
};
