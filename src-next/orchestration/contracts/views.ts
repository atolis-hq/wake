import type { ActivityOutcome } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { StageConfig } from './config.js';

export interface ActivityActivationView {
  readonly activationId: string;
  readonly ordinal: number;
  readonly activity: string;
  readonly input: unknown;
  readonly execution: StageConfig['execution'];
  readonly status: 'pending' | 'running' | 'completed';
  readonly followOnIndex?: number;
  readonly supplemental?: boolean;
}
export interface SignalExpectationView {
  readonly signalKind: string;
  readonly resourceId?: string;
  readonly revision?: string;
}
export interface SupplementalActivityView {
  readonly activity: string;
  readonly input: unknown;
  readonly requestedBy: string;
}
export interface GroupBudgetExhaustedView {
  readonly kind: 'group-budget-exhausted';
  readonly requestId: string;
}
export interface WorkflowInstanceView {
  readonly workflowInstanceId: string;
  readonly workItemId: WorkItemId;
  readonly workflowName: string;
  readonly orchestrationGroupId: string;
  readonly parentWorkflowInstanceId?: string;
  readonly watchId?: string;
  readonly triggerId?: string;
  readonly causalCycleId?: string;
  readonly requestId?: string;
  readonly status: 'active' | 'waiting' | 'completed' | 'blocked' | 'superseded';
  readonly currentStage: string;
  readonly pendingActivation?: ActivityActivationView;
  readonly repeatCounts: Readonly<Record<string, number>>;
  readonly retryCounts: Readonly<Record<string, number>>;
  readonly waitingFor?: SignalExpectationView;
  readonly supplementalQueue: readonly SupplementalActivityView[];
  readonly acceptedSignalIds: readonly string[];
  readonly acceptedOutcomes: readonly string[];
  readonly acceptedChildCompletionIds: readonly string[];
  readonly causalRejectionIds: readonly string[];
  readonly childCompletionRecorded: boolean;
  readonly lastOutcome?: ActivityOutcome;
}
