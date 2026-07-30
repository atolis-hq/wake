import type { EventDraft } from '../../kernel/index.js';

export interface ChildCoordinationMetadata {
  readonly parentWorkflowInstanceId: string;
  readonly watchId: string;
  readonly triggerId: string;
  readonly orchestrationGroupId: string;
  readonly causalCycleId: string;
  readonly requestId: string;
  readonly childWorkflowInstanceId: string;
}

export interface ChildRequestedPayload extends ChildCoordinationMetadata {
  readonly workflowName: string;
}

export type ChildStartedPayload = ChildCoordinationMetadata;
export type ChildCompletedPayload = ChildCoordinationMetadata;
export type ChildCompletionConsumedPayload = ChildCoordinationMetadata;
export type CausalActivationRejectedPayload = ChildCoordinationMetadata;

export interface GroupBudgetExhaustedPayload extends ChildCoordinationMetadata {
  readonly maxPerGroup: number;
}

export interface ChildCoordinationEventPayloads {
  readonly 'orchestration.child-requested': ChildRequestedPayload;
  readonly 'orchestration.child-started': ChildStartedPayload;
  readonly 'orchestration.child-completed': ChildCompletedPayload;
  readonly 'orchestration.child-completion-consumed': ChildCompletionConsumedPayload;
  readonly 'orchestration.causal-activation-rejected': CausalActivationRejectedPayload;
  readonly 'orchestration.group-budget-exhausted': GroupBudgetExhaustedPayload;
}

export type OrchestrationEventDraft = {
  [Type in keyof ChildCoordinationEventPayloads]: EventDraft<
    Type,
    ChildCoordinationEventPayloads[Type]
  >;
}[keyof ChildCoordinationEventPayloads];
export type ChildCoordinationEventDraft = OrchestrationEventDraft;

export interface SignalExpectation {
  readonly signalKind: string;
  readonly resourceId?: string;
  readonly revision?: string;
}

export interface OrchestrationSignal {
  readonly kind: string;
  readonly resourceId?: string;
  readonly revision?: string;
  readonly actorId: string;
  readonly actorDecision: {
    readonly authorized: boolean;
    readonly evidenceId: string;
  };
  readonly providerEventId: string;
}

export interface ChildCompletionSignal extends OrchestrationSignal {
  readonly kind: 'orchestration.child-completed';
  readonly childWorkflowInstanceId: string;
  readonly requestId: string;
}

export interface SupplementalActivityRequest {
  readonly command: string;
}

export interface ChildWorkflowRequest {
  readonly parentWorkflowInstanceId: string;
  readonly watchId: string;
  readonly triggerId: string;
  readonly workflowName: string;
  readonly causalCycleId: string;
  readonly requestId: string;
}
