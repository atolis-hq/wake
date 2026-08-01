import type { ActivationId, ActivityName } from '../../activities/index.js';
import type { ApprovalAuthority, StageConfig, TransitionTarget } from './config.js';
import type {
  CommandName,
  OrchestrationGroupId,
  SignalName,
  WorkflowInstanceId,
  WorkflowName,
} from './identifiers.js';

export interface ChildCoordinationMetadata {
  readonly parentWorkflowInstanceId: WorkflowInstanceId;
  readonly watchId: string;
  readonly triggerId: string;
  readonly orchestrationGroupId: OrchestrationGroupId;
  readonly causalCycleId: string;
  readonly requestId: string;
  readonly childWorkflowInstanceId: WorkflowInstanceId;
}

export interface ChildRequestedPayload extends ChildCoordinationMetadata {
  readonly workflowName: WorkflowName;
}

export type ChildStartedPayload = ChildCoordinationMetadata;
export type ChildCompletedPayload = ChildCoordinationMetadata;
export type ChildCompletionConsumedPayload = ChildCoordinationMetadata;
export type CausalActivationRejectedPayload = ChildCoordinationMetadata;

export interface GroupBudgetExhaustedPayload extends ChildCoordinationMetadata {
  readonly maxPerGroup: number;
}

export interface ActivityRequestedPayload {
  readonly activationId: ActivationId;
  readonly ordinal: number;
  readonly activity: ActivityName;
  readonly input: unknown;
  readonly execution?: StageConfig['execution'] | undefined;
  readonly followOnIndex?: number | undefined;
  readonly supplemental?: boolean | undefined;
}

export interface SignalExpectation {
  readonly signalKind: SignalName;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  // Present only for an authority-gated wait; absent waits accept any matching signal.
  readonly from?: readonly ApprovalAuthority[] | undefined;
  readonly resume?: TransitionTarget | undefined;
}

export interface OrchestrationSignal {
  readonly kind: SignalName;
  readonly resourceId?: string | undefined;
  readonly revision?: string | undefined;
  readonly actorId: string;
  readonly actorDecision: {
    readonly authorized: boolean;
    readonly evidenceId: string;
  };
  readonly providerEventId: string;
  // The permission under which the signal opens the gate; absent claims human authority.
  readonly authority?: ApprovalAuthority | undefined;
}

export interface SupplementalActivityRequest {
  readonly command: CommandName;
}

export interface ChildWorkflowRequest {
  readonly parentWorkflowInstanceId: WorkflowInstanceId;
  readonly watchId: string;
  readonly triggerId: string;
  readonly workflowName: WorkflowName;
  readonly causalCycleId: string;
  readonly requestId: WorkflowInstanceId;
}
