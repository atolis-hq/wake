import { selectRunExecutionEvent, type RunRepository } from '../../execution/index.js';
import type { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import { isWorkflowInstanceStream } from '../contracts/streams.js';

type PersistedEvent = Parameters<typeof selectOrchestrationEvent>[0];

/**
 * Resolve the one instance an event belongs to, when it has one. Run events
 * inherit their scope from the run. `ChildCompleted` deliberately does not:
 * it is a cross-instance coordination fact and stream-scoping it would hide
 * valid parent/child coordination from other eligible instances.
 */
export async function resolveTriggerWorkflowInstanceId(
  event: PersistedEvent,
  runs: Pick<RunRepository, 'load'> | undefined,
): Promise<WorkflowInstanceId | undefined> {
  if (
    event.eventType === OrchestrationEventType.SignalWaitStarted &&
    isWorkflowInstanceStream(event.stream)
  )
    return event.stream.id;
  if (runs === undefined) return undefined;
  const runEvent = selectRunExecutionEvent(event);
  if (runEvent === null) return undefined;
  return (await runs.load(runEvent.stream.id)).view?.workflowInstanceId;
}
