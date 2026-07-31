import { createEventDraft, type EventDraft } from '../../kernel/index.js';
import { workflowInstanceId } from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import type {
  ChildCoordinationEventPayloads,
  ChildCoordinationMetadata,
} from '../contracts/events.js';

interface CoordinationDraftContext {
  readonly workflowInstanceId: string;
  readonly eventIdPrefix: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
}

const actor = { kind: 'system' as const, id: 'orchestration' };
const source = { kind: 'internal' as const, id: 'orchestration' };

export function coordinationDraft<Type extends keyof ChildCoordinationEventPayloads>(
  context: CoordinationDraftContext,
  eventType: Type,
  payload: ChildCoordinationEventPayloads[Type],
  ordinal: number,
): EventDraft<Type, ChildCoordinationEventPayloads[Type]> {
  return createEventDraft({
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
  workflowName: string,
) {
  return [
    coordinationDraft(context, 'orchestration.child-requested', { ...metadata, workflowName }, 1),
    coordinationDraft(context, 'orchestration.child-started', metadata, 2),
  ] as const;
}
