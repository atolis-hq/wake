import { OrchestrationEventType as Event } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/** A review of the old basis cannot approve a new wait with the same watch name. */
export async function watchPredatesPrerequisiteRefresh(
  repository: OrchestrationRepository,
  child: WorkflowInstanceView,
): Promise<boolean> {
  if (child.parentWorkflowInstanceId === undefined) return false;
  const parent = await repository.history(child.parentWorkflowInstanceId);
  const refresh = parent.events
    .filter(({ event }) => event.eventType === Event.DelegationInputsRefreshed)
    .at(-1);
  if (refresh === undefined) return false;
  const trigger = parent.events.find(({ event }) => event.eventId === child.triggerId);
  if (trigger !== undefined && trigger.globalPosition < refresh.globalPosition) return true;
  const own = await repository.history(child.workflowInstanceId);
  const start = own.events.find(({ event }) => event.eventType === Event.InstanceStarted);
  return start === undefined || start.globalPosition < refresh.globalPosition;
}
