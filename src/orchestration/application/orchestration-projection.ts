import type { ProjectionDefinition } from '../../kernel/index.js';
import { selectWorkflowOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType, type WorkflowOrchestrationEvent } from '../contracts/events.js';
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

/** Workflow-instance membership keyed by its owning work item for scoped readers. */
export const workflowsByWorkItemProjection: ProjectionDefinition<
  readonly WorkflowInstanceView['workflowInstanceId'][]
> = {
  name: 'workflows-by-work-item',
  select(event) {
    const owned = selectWorkflowOrchestrationEvent(event);
    return owned?.event.eventType === OrchestrationEventType.InstanceStarted &&
      isWorkflowInstanceStream(owned.stream)
      ? { key: owned.event.payload.workItemId }
      : null;
  },
  initial: () => [],
  project(previous, event) {
    const owned = selectWorkflowOrchestrationEvent(event);
    if (
      owned?.event.eventType !== OrchestrationEventType.InstanceStarted ||
      !isWorkflowInstanceStream(owned.stream)
    )
      return previous;
    return previous.includes(owned.stream.id) ? previous : [...previous, owned.stream.id];
  },
};
