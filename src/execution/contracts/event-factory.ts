import { createEventData, type EventDataInput } from '../../kernel/index.js';
import {
  ExecutionEventType,
  type ActivationExecutionEventData,
  type ActivationExecutionEventPayloads,
  type ExecutionEventData,
  type RunExecutionEventData,
  type RunExecutionEventPayloads,
} from './events.js';

export type RunExecutionEventDataInput = {
  [Type in keyof RunExecutionEventPayloads]: EventDataInput<Type, RunExecutionEventPayloads[Type]>;
}[keyof RunExecutionEventPayloads];

export type ActivationExecutionEventDataInput = {
  [Type in keyof ActivationExecutionEventPayloads]: EventDataInput<
    Type,
    ActivationExecutionEventPayloads[Type]
  >;
}[keyof ActivationExecutionEventPayloads];

export type ExecutionEventDataInput =
  RunExecutionEventDataInput | ActivationExecutionEventDataInput;

// Exhaustive dispatch preserves the closed event-to-payload mapping.
// eslint-disable-next-line complexity
export function createRunExecutionEventData(
  input: RunExecutionEventDataInput,
): RunExecutionEventData {
  switch (input.eventType) {
    case ExecutionEventType.RunPreparationStarted:
      return createEventData(input);
    case ExecutionEventType.RunStarted:
      return createEventData(input);
    case ExecutionEventType.RunSucceeded:
      return createEventData(input);
    case ExecutionEventType.RunFailed:
      return createEventData(input);
    case ExecutionEventType.RunLeaseClaimed:
      return createEventData(input);
    case ExecutionEventType.RunLeaseRenewed:
      return createEventData(input);
    case ExecutionEventType.RunExternalExecutionReported:
      return createEventData(input);
    case ExecutionEventType.RunRunnerResultReported:
      return createEventData(input);
    case ExecutionEventType.RunWorkspaceCleanupFailed:
      return createEventData(input);
    case ExecutionEventType.RunCancellationRequested:
      return createEventData(input);
    case ExecutionEventType.RunCancellationConfirmed:
      return createEventData(input);
    case ExecutionEventType.RunCancelled:
      return createEventData(input);
    case ExecutionEventType.RunRecovered:
      return createEventData(input);
    case ExecutionEventType.RunAmbiguityObserved:
      return createEventData(input);
    case ExecutionEventType.RunAmbiguous:
      return createEventData(input);
  }
}

export function createActivationExecutionEventData(
  input: ActivationExecutionEventDataInput,
): ActivationExecutionEventData {
  switch (input.eventType) {
    case ExecutionEventType.ActivationClaimed:
      return createEventData(input);
    case ExecutionEventType.ActivationReleased:
      return createEventData(input);
  }
}

export function createExecutionEventData(input: RunExecutionEventDataInput): RunExecutionEventData;

export function createExecutionEventData(
  input: ActivationExecutionEventDataInput,
): ActivationExecutionEventData;

export function createExecutionEventData(input: ExecutionEventDataInput): ExecutionEventData {
  switch (input.eventType) {
    case ExecutionEventType.ActivationClaimed:
    case ExecutionEventType.ActivationReleased:
      return createActivationExecutionEventData(input);
    default:
      return createRunExecutionEventData(input);
  }
}
