import type { ProjectionDefinition } from '@atolis-hq/eventing';
import { selectWorkflowOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { isWorkflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { continueWorkflowInstance } from '../domain/workflow-instance.js';

export type WorkflowInstanceProjectionValue = WorkflowInstanceView | null;

type LegacyWorkflowInstanceProjectionValue = {
  readonly events: readonly unknown[];
  readonly view: WorkflowInstanceView | null;
};

export type StoredWorkflowInstanceProjectionValue =
  WorkflowInstanceProjectionValue | LegacyWorkflowInstanceProjectionValue;

/** Reads the canonical view while tolerating the pre-envelope projection shape. */
export function workflowInstanceProjectionView(
  value: StoredWorkflowInstanceProjectionValue,
): WorkflowInstanceProjectionValue {
  return isLegacyWorkflowInstanceProjectionValue(value) ? value.view : value;
}

export const orchestrationProjection: ProjectionDefinition<StoredWorkflowInstanceProjectionValue> =
  {
    name: 'orchestration',
    select(event) {
      const owned = selectWorkflowOrchestrationEvent(event);
      return owned !== null && isWorkflowInstanceStream(owned.stream)
        ? { key: owned.stream.id }
        : null;
    },
    initial: () => null,
    project(previous, event) {
      const owned = selectWorkflowOrchestrationEvent(event);
      if (owned === null || !isWorkflowInstanceStream(owned.stream)) return previous;
      return continueWorkflowInstance(workflowInstanceProjectionView(previous), owned);
    },
  };

function isLegacyWorkflowInstanceProjectionValue(
  value: StoredWorkflowInstanceProjectionValue,
): value is LegacyWorkflowInstanceProjectionValue {
  return value !== null && 'events' in value && 'view' in value;
}

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
