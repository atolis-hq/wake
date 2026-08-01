import type { ActivationId, ActivityName, ActivityOutcome } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ApprovalAuthority, StageConfig, TransitionTarget } from './config.js';
import type {
  OrchestrationGroupId,
  SignalName,
  StageName,
  WorkflowInstanceId,
  WorkflowName,
} from './identifiers.js';
import type { ActivityActivationStatus, WorkflowStatus } from './vocabulary.js';

export interface ActivityActivationView {
  readonly activationId: ActivationId;
  readonly ordinal: number;
  readonly activity: ActivityName;
  readonly input: unknown;
  readonly execution: StageConfig['execution'];
  readonly status: ActivityActivationStatus;
  readonly followOnIndex?: number;
  readonly supplemental?: boolean;
}
export interface SignalExpectationView {
  readonly signalKind: SignalName;
  readonly intentEventId?: string;
  readonly resourceId?: string;
  readonly revision?: string;
  readonly from?: readonly ApprovalAuthority[];
  readonly resume?: TransitionTarget;
}
export interface SupplementalActivityView {
  readonly activity: ActivityName;
  readonly input: unknown;
  readonly requestedBy: string;
}
export interface GroupBudgetExhaustedView {
  readonly kind: 'group-budget-exhausted';
  readonly requestId: string;
}
export interface WorkflowInstanceView {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly workItemId: WorkItemId;
  readonly workflowName: WorkflowName;
  readonly orchestrationGroupId: OrchestrationGroupId;
  readonly parentWorkflowInstanceId?: WorkflowInstanceId;
  readonly watchId?: string;
  readonly triggerId?: string;
  readonly causalCycleId?: string;
  readonly requestId?: string;
  readonly status: WorkflowStatus;
  readonly currentStage: StageName;
  readonly pendingActivation?: ActivityActivationView;
  readonly repeatCounts: Readonly<Record<string, number>>;
  readonly retryCounts: Readonly<Record<string, number>>;
  readonly waitingFor?: SignalExpectationView;
  readonly supplementalQueue: readonly SupplementalActivityView[];
  readonly acceptedSignalIds: readonly string[];
  readonly acceptedOutcomes: readonly ActivationId[];
  readonly acceptedChildCompletionIds: readonly WorkflowInstanceId[];
  readonly causalRejectionIds: readonly string[];
  readonly childCompletionRecorded: boolean;
  readonly lastOutcome?: ActivityOutcome;
}
