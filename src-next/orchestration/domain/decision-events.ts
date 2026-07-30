import { createEventDraft, entityRef, type EventDraft } from '../../kernel/index.js';
import type { WorkflowInstanceView } from '../contracts/views.js';

interface DecisionContext {
  readonly occurredAt: string;
  readonly causationId: string;
}

interface StartDraftContext extends DecisionContext {
  readonly workflowInstanceId: string;
  readonly correlationId: string;
}

const actor = { kind: 'system' as const, id: 'orchestration' };
const source = { kind: 'internal' as const, id: 'orchestration' };

export function nextOrdinal(state: WorkflowInstanceView): number {
  return (state.pendingActivation?.ordinal ?? 0) + 1;
}

export function activation(
  id: string,
  ordinal: number,
  activity: string,
  input: unknown,
  options: {
    readonly execution: unknown;
    readonly followOnIndex?: number;
    readonly supplemental?: boolean;
  },
) {
  return {
    activationId: `${id}:activity:${ordinal}`,
    ordinal,
    activity,
    input,
    execution: options.execution,
    ...(options.followOnIndex === undefined ? {} : { followOnIndex: options.followOnIndex }),
    ...(options.supplemental === true ? { supplemental: true } : {}),
  };
}

export function startDraft(
  input: StartDraftContext,
  suffix: string,
  payload: unknown,
  ordinal: number,
): EventDraft {
  return createEventDraft({
    eventId: `${input.causationId}:orchestration.${suffix}:${ordinal}`,
    eventType: `orchestration.${suffix}`,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor,
    source,
    stream: entityRef('workflow-instance', input.workflowInstanceId),
    payload,
  });
}

export function stateDraft(
  state: WorkflowInstanceView,
  input: DecisionContext,
  suffix: string,
  payload: unknown,
  ordinal: number,
): EventDraft {
  return createEventDraft({
    eventId: `${input.causationId}:orchestration.${suffix}:${ordinal}`,
    eventType: `orchestration.${suffix}`,
    occurredAt: input.occurredAt,
    correlationId: state.orchestrationGroupId,
    causationId: input.causationId,
    actor,
    source,
    stream: entityRef('workflow-instance', state.workflowInstanceId),
    payload,
  });
}
