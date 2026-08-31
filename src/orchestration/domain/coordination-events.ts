import { EventActorKind, EventSourceKind } from '@atolis-hq/eventing';
import { createOrchestrationEventData } from '../contracts/event-factory.js';
import type {
  ChildCoordinationEventData,
  ChildCoordinationEventPayloads,
  ChildCoordinationMetadata,
  OrchestrationEventData,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceId, WorkflowName } from '../contracts/identifiers.js';

interface CoordinationDraftContext {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly eventIdPrefix: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
}

const actor = { kind: EventActorKind.System, id: 'orchestration' };
const source = { kind: EventSourceKind.Internal, id: 'orchestration' };

type CoordinationDraftInput = {
  [Type in keyof ChildCoordinationEventPayloads]: {
    readonly eventType: Type;
    readonly payload: ChildCoordinationEventPayloads[Type];
  };
}[keyof ChildCoordinationEventPayloads];

export function coordinationDraft(
  context: CoordinationDraftContext,
  event: CoordinationDraftInput,
  ordinal: number,
): ChildCoordinationEventData {
  const draft = createOrchestrationEventData({
    eventId: `${context.eventIdPrefix}:${event.eventType}:${ordinal}`,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.causationId,
    actor,
    source,
    ...event,
  });
  return requireChildCoordinationEventData(draft);
}

export function childStartDrafts(
  context: CoordinationDraftContext,
  metadata: ChildCoordinationMetadata,
  workflowName: WorkflowName,
) {
  return [
    coordinationDraft(
      context,
      {
        eventType: OrchestrationEventType.ChildRequested,
        payload: { ...metadata, workflowName },
      },
      1,
    ),
    coordinationDraft(
      context,
      { eventType: OrchestrationEventType.ChildStarted, payload: metadata },
      2,
    ),
  ] as const;
}

function requireChildCoordinationEventData(
  event: OrchestrationEventData,
): ChildCoordinationEventData {
  switch (event.eventType) {
    case OrchestrationEventType.ChildRequested:
    case OrchestrationEventType.ChildStarted:
    case OrchestrationEventType.ChildCompleted:
    case OrchestrationEventType.ChildCompletionConsumed:
    case OrchestrationEventType.CausalActivationRejected:
    case OrchestrationEventType.GroupBudgetExhausted:
      return event;
    default:
      throw new Error(`Expected child-coordination event data, received ${event.eventType}`);
  }
}
