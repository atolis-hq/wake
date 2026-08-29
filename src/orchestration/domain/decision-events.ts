import { activationId, type ActivityName } from '../../activities/index.js';
import { createEventDraft, EventActorKind, EventSourceKind } from '../../kernel/index.js';
import {
  type ActivityRequestedPayload,
  type OrchestrationEventPayloads,
  type WorkflowOrchestrationEventName,
} from '../contracts/events.js';
import {
  workflowInstanceId,
  type StageName,
  type WorkflowInstanceId,
} from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';

interface DecisionContext {
  readonly occurredAt: string;
  readonly causationId: string;
}

interface StartDraftContext extends DecisionContext {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly correlationId: string;
}

const actor = { kind: EventActorKind.System, id: 'orchestration' };
const source = { kind: EventSourceKind.Internal, id: 'orchestration' };

export function nextOrdinal(state: WorkflowInstanceView): number {
  return (state.pendingActivation?.ordinal ?? 0) + 1;
}

export function activation(
  id: WorkflowInstanceId,
  ordinal: number,
  activity: ActivityName,
  input: unknown,
  options: {
    readonly execution: ActivityRequestedPayload['execution'];
    readonly sessionPolicy?: ActivityRequestedPayload['sessionPolicy'];
    readonly stage?: StageName;
    readonly followOnIndex?: number;
    readonly supplemental?: boolean;
  },
): ActivityRequestedPayload {
  return {
    activationId: activationId(`${id}:activity:${ordinal}`),
    ordinal,
    activity,
    ...(options.stage === undefined ? {} : { stage: options.stage }),
    input,
    execution: options.execution,
    ...(options.sessionPolicy === undefined ? {} : { sessionPolicy: options.sessionPolicy }),
    ...(options.followOnIndex === undefined ? {} : { followOnIndex: options.followOnIndex }),
    ...(options.supplemental === true ? { supplemental: true } : {}),
  };
}

export function startDraft<Type extends WorkflowOrchestrationEventName>(
  input: StartDraftContext,
  eventType: Type,
  payload: OrchestrationEventPayloads[Type],
  ordinal: number,
) {
  return createEventDraft({
    eventId: `${input.causationId}:${eventType}:${ordinal}`,
    eventType,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor,
    source,
    stream: workflowInstanceStream(workflowInstanceId(input.workflowInstanceId)),
    payload,
  });
}

export function stateDraft<Type extends WorkflowOrchestrationEventName>(
  state: WorkflowInstanceView,
  input: DecisionContext,
  eventType: Type,
  payload: OrchestrationEventPayloads[Type],
  ordinal: number,
) {
  return createEventDraft({
    eventId: `${input.causationId}:${eventType}:${ordinal}`,
    eventType,
    occurredAt: input.occurredAt,
    correlationId: state.orchestrationGroupId,
    causationId: input.causationId,
    actor,
    source,
    stream: workflowInstanceStream(workflowInstanceId(state.workflowInstanceId)),
    payload,
  });
}
