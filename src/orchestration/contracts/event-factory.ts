import { createEventData, type EventDataInput } from '@atolis-hq/eventing';
import {
  OrchestrationEventType,
  type OrchestrationEventData,
  type OrchestrationEventPayloads,
} from './events.js';

export type OrchestrationEventDataInput = {
  [Type in keyof OrchestrationEventPayloads]: EventDataInput<
    Type,
    OrchestrationEventPayloads[Type]
  >;
}[keyof OrchestrationEventPayloads];

// Exhaustive dispatch preserves the closed event-to-payload mapping.
// eslint-disable-next-line complexity
export function createOrchestrationEventData(
  input: OrchestrationEventDataInput,
): OrchestrationEventData {
  switch (input.eventType) {
    case OrchestrationEventType.DelegationInputsResolved:
      return createEventData(input);
    case OrchestrationEventType.DelegationPrerequisiteBlocked:
    case OrchestrationEventType.DelegationChildBlocked:
      return createEventData(input);
    case OrchestrationEventType.DelegationFailed:
    case OrchestrationEventType.DelegationReconciliationFailed:
      return createEventData(input);
    case OrchestrationEventType.DelegationReserved:
      return createEventData(input);
    case OrchestrationEventType.DelegationRegistered:
      return createEventData(input);
    case OrchestrationEventType.DelegationResultSelected:
      return createEventData(input);
    case OrchestrationEventType.DelegationWaitStarted:
      return createEventData(input);
    case OrchestrationEventType.DelegationJoined:
      return createEventData(input);
    case OrchestrationEventType.WorkflowDefinitionRegistered:
      return createEventData(input);
    case OrchestrationEventType.InstanceStarted:
      return createEventData(input);
    case OrchestrationEventType.StageEntered:
      return createEventData(input);
    case OrchestrationEventType.ActivityRequested:
      return createEventData(input);
    case OrchestrationEventType.ActivityStarted:
      return createEventData(input);
    case OrchestrationEventType.ActivityOutcomeAccepted:
      return createEventData(input);
    case OrchestrationEventType.ActivityExecutionFailed:
      return createEventData(input);
    case OrchestrationEventType.ActivityRetriedForRunnerQuota:
      return createEventData(input);
    case OrchestrationEventType.ActivityWaiting:
      return createEventData(input);
    case OrchestrationEventType.SignalWaitStarted:
      return createEventData(input);
    case OrchestrationEventType.SignalDeferred:
      return createEventData(input);
    case OrchestrationEventType.SignalAccepted:
      return createEventData(input);
    case OrchestrationEventType.SupplementalActivityQueued:
      return createEventData(input);
    case OrchestrationEventType.SupplementalActivityDequeued:
      return createEventData(input);
    case OrchestrationEventType.RepeatCounted:
      return createEventData(input);
    case OrchestrationEventType.RetryCounted:
      return createEventData(input);
    case OrchestrationEventType.InstanceCompleted:
      return createEventData(input);
    case OrchestrationEventType.InstanceBlocked:
      return createEventData(input);
    case OrchestrationEventType.OperatorRetryRequested:
      return createEventData(input);
    case OrchestrationEventType.InstanceSuperseded:
      return createEventData(input);
    case OrchestrationEventType.ChildRequested:
      return createEventData(input);
    case OrchestrationEventType.ChildStarted:
    case OrchestrationEventType.ChildCompleted:
    case OrchestrationEventType.ChildCompletionConsumed:
    case OrchestrationEventType.CausalActivationRejected:
      return createEventData(input);
    case OrchestrationEventType.GroupBudgetExhausted:
      return createEventData(input);
    case OrchestrationEventType.PrimaryClaimed:
      return createEventData(input);
    case OrchestrationEventType.GroupClaimed:
      return createEventData(input);
    case OrchestrationEventType.GroupBudgetGranted:
      return createEventData(input);
  }
}
