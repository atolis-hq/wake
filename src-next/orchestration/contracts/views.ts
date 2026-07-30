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
}
export interface WorkflowInstanceView {
  readonly workflowInstanceId: string;
  readonly workItemId: WorkItemId;
  readonly workflowName: string;
  readonly orchestrationGroupId: string;
  readonly status: 'active' | 'waiting' | 'completed' | 'blocked' | 'superseded';
  readonly currentStage: string;
  readonly pendingActivation?: ActivityActivationView;
  readonly repeatCounts: Readonly<Record<string, number>>;
  readonly acceptedOutcomes: readonly string[];
  readonly lastOutcome?: ActivityOutcome;
}
