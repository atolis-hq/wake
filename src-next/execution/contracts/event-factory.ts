import { createEventDraft, type EventDraftInput } from '../../kernel/index.js';
import {
  ExecutionEventType,
  type ActivationExecutionEventDraft,
  type ActivationExecutionEventPayloads,
  type ExecutionEventDraft,
  type RunExecutionEventDraft,
  type RunExecutionEventPayloads,
} from './events.js';
import type { ActivationStreamRef, RunStreamRef } from './streams.js';

export type RunExecutionEventDraftInput = {
  [Type in keyof RunExecutionEventPayloads]: EventDraftInput<
    Type,
    RunExecutionEventPayloads[Type],
    RunStreamRef
  >;
}[keyof RunExecutionEventPayloads];

export type ActivationExecutionEventDraftInput = {
  [Type in keyof ActivationExecutionEventPayloads]: EventDraftInput<
    Type,
    ActivationExecutionEventPayloads[Type],
    ActivationStreamRef
  >;
}[keyof ActivationExecutionEventPayloads];

export type ExecutionEventDraftInput =
  RunExecutionEventDraftInput | ActivationExecutionEventDraftInput;

// Exhaustive dispatch preserves the closed event-to-payload mapping.
// eslint-disable-next-line complexity
export function createRunExecutionEventDraft(
  input: RunExecutionEventDraftInput,
): RunExecutionEventDraft {
  switch (input.eventType) {
    case ExecutionEventType.RunStarted:
      return createEventDraft(input);
    case ExecutionEventType.RunSucceeded:
      return createEventDraft(input);
    case ExecutionEventType.RunFailed:
      return createEventDraft(input);
    case ExecutionEventType.RunLeaseClaimed:
      return createEventDraft(input);
    case ExecutionEventType.RunLeaseRenewed:
      return createEventDraft(input);
    case ExecutionEventType.RunExternalExecutionReported:
      return createEventDraft(input);
    case ExecutionEventType.RunRunnerResultReported:
      return createEventDraft(input);
    case ExecutionEventType.RunWorkspaceCleanupFailed:
      return createEventDraft(input);
    case ExecutionEventType.RunCancellationRequested:
      return createEventDraft(input);
    case ExecutionEventType.RunCancellationConfirmed:
      return createEventDraft(input);
    case ExecutionEventType.RunCancelled:
      return createEventDraft(input);
    case ExecutionEventType.RunRecovered:
      return createEventDraft(input);
    case ExecutionEventType.RunAmbiguityObserved:
      return createEventDraft(input);
    case ExecutionEventType.RunAmbiguous:
      return createEventDraft(input);
  }
}

export function createActivationExecutionEventDraft(
  input: ActivationExecutionEventDraftInput,
): ActivationExecutionEventDraft {
  switch (input.eventType) {
    case ExecutionEventType.ActivationClaimed:
      return createEventDraft(input);
    case ExecutionEventType.ActivationReleased:
      return createEventDraft(input);
  }
}

export function createExecutionEventDraft(
  input: RunExecutionEventDraftInput,
): RunExecutionEventDraft;

export function createExecutionEventDraft(
  input: ActivationExecutionEventDraftInput,
): ActivationExecutionEventDraft;

export function createExecutionEventDraft(input: ExecutionEventDraftInput): ExecutionEventDraft {
  switch (input.eventType) {
    case ExecutionEventType.ActivationClaimed:
    case ExecutionEventType.ActivationReleased:
      return createActivationExecutionEventDraft(input);
    default:
      return createRunExecutionEventDraft(input);
  }
}
