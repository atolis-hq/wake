import { createEventData, EventActorKind, EventSourceKind } from '../../kernel/index.js';
import type {
  ChildCoordinationEventPayloads,
  ChildCoordinationMetadata,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import {
  workflowInstanceId,
  type WorkflowInstanceId,
  type WorkflowName,
} from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';

interface CoordinationDraftContext {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly eventIdPrefix: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
}

const actor = { kind: EventActorKind.System, id: 'orchestration' };
const source = { kind: EventSourceKind.Internal, id: 'orchestration' };

export function coordinationDraft<Type extends keyof ChildCoordinationEventPayloads>(
  context: CoordinationDraftContext,
  eventType: Type,
  payload: ChildCoordinationEventPayloads[Type],
  ordinal: number,
) {
  return createEventData({
    eventId: `${context.eventIdPrefix}:${eventType}:${ordinal}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.causationId,
    actor,
    source,
    stream: workflowInstanceStream(workflowInstanceId(context.workflowInstanceId)),
    payload,
  });
}

export function childStartDrafts(
  context: CoordinationDraftContext,
  metadata: ChildCoordinationMetadata,
  workflowName: WorkflowName,
) {
  return [
    coordinationDraft(
      context,
      OrchestrationEventType.ChildRequested,
      { ...metadata, workflowName },
      1,
    ),
    coordinationDraft(context, OrchestrationEventType.ChildStarted, metadata, 2),
  ] as const;
}
