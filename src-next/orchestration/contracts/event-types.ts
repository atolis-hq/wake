import type { StageConfig } from './config.js';

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

export interface ActivityRequestedPayload {
  readonly activationId: string;
  readonly ordinal: number;
  readonly activity: string;
  readonly input: unknown;
  readonly execution?: StageConfig['execution'] | undefined;
  readonly followOnIndex?: number | undefined;
  readonly supplemental?: boolean | undefined;
}

export interface SignalExpectation {
  readonly signalKind: string;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
}

export interface OrchestrationSignal {
  readonly kind: string;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  readonly actorId: string;
  readonly actorDecision: {
    readonly authorized: boolean;
    readonly evidenceId: string;
  };
  readonly providerEventId: string;
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
