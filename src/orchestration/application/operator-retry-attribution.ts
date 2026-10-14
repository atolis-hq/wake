import type { EventActor } from '@atolis-hq/eventing';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEventData,
} from '../contracts/events.js';
import { workflowEventData } from '../domain/decision-events.js';

export function attributeOperatorRetry(
  events: readonly WorkflowOrchestrationEventData[],
  actor: EventActor,
): readonly WorkflowOrchestrationEventData[] {
  return events.map((event) =>
    event.eventType === OrchestrationEventType.OperatorRetryRequested
      ? workflowEventData({ ...event, actor })
      : event,
  );
}
