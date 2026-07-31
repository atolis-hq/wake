import { createEventDraft, type EventDraftInput } from '../../kernel/index.js';
import {
  ExecutionEventType,
  type ExecutionEventDraft,
  type ExecutionEventPayloads,
} from './events.js';
import type { RunStreamRef } from './streams.js';

export type ExecutionEventDraftInput = {
  [Type in keyof ExecutionEventPayloads]: EventDraftInput<
    Type,
    ExecutionEventPayloads[Type],
    RunStreamRef
  >;
}[keyof ExecutionEventPayloads];

export function createExecutionEventDraft(input: ExecutionEventDraftInput): ExecutionEventDraft {
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
    case ExecutionEventType.RunCancellationRequested:
      return createEventDraft(input);
    case ExecutionEventType.RunCancellationConfirmed:
      return createEventDraft(input);
    case ExecutionEventType.RunCancelled:
      return createEventDraft(input);
    case ExecutionEventType.RunRecovered:
      return createEventDraft(input);
    case ExecutionEventType.RunAmbiguous:
      return createEventDraft(input);
  }
}
