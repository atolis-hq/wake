import { activationId, type ActivityName } from '../../activities/index.js';
import { EventActorKind, EventSourceKind } from '../../kernel/index.js';
import {
  createOrchestrationEventData,
  type OrchestrationEventDataInput,
} from '../contracts/event-factory.js';
import {
  OrchestrationEventType,
  type ActivityRequestedPayload,
  type OrchestrationEventData,
  type OrchestrationEventPayloads,
  type WorkflowOrchestrationEventData,
  type WorkflowOrchestrationEventName,
} from '../contracts/events.js';
import type { StageName, WorkflowInstanceId } from '../contracts/identifiers.js';
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

type WorkflowDraftInput = {
  [Type in WorkflowOrchestrationEventName]: {
    readonly eventType: Type;
    readonly payload: OrchestrationEventPayloads[Type];
  };
}[WorkflowOrchestrationEventName];

export function startDraft(
  input: StartDraftContext,
  event: WorkflowDraftInput,
  ordinal: number,
): WorkflowOrchestrationEventData {
  return workflowEventData({
    eventId: `${input.causationId}:${event.eventType}:${ordinal}`,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor,
    source,
    ...event,
  });
}

export function stateDraft(
  state: WorkflowInstanceView,
  input: DecisionContext,
  event: WorkflowDraftInput,
  ordinal: number,
): WorkflowOrchestrationEventData {
  return workflowEventData({
    eventId: `${input.causationId}:${event.eventType}:${ordinal}`,
    occurredAt: input.occurredAt,
    correlationId: state.orchestrationGroupId,
    causationId: input.causationId,
    actor,
    source,
    ...event,
  });
}

export function workflowEventData(
  input: Extract<
    OrchestrationEventDataInput,
    { readonly eventType: WorkflowOrchestrationEventName }
  >,
): WorkflowOrchestrationEventData {
  const event = createOrchestrationEventData(input);
  return requireWorkflowEventData(event);
}

function requireWorkflowEventData(event: OrchestrationEventData): WorkflowOrchestrationEventData {
  switch (event.eventType) {
    case OrchestrationEventType.WorkflowDefinitionRegistered:
    case OrchestrationEventType.PrimaryClaimed:
    case OrchestrationEventType.GroupClaimed:
    case OrchestrationEventType.GroupBudgetGranted:
      throw new Error(`Expected Workflow event data, received ${event.eventType}`);
    default:
      return event;
  }
}
