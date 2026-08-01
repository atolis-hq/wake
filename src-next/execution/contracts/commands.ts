import type {
  ActivationId,
  ActivityName,
  ActivityOrchestrationGroupId,
  ActivityWorkflowInstanceId,
} from '../../activities/index.js';
import type { ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { WorkspaceMode } from './vocabulary.js';

export interface ExecutionActivation {
  readonly activationId: ActivationId;
  readonly ordinal: number;
  readonly activity: ActivityName;
  readonly input: unknown;
  readonly execution:
    | {
        readonly workspace?: WorkspaceMode | undefined;
        readonly tier?: string | undefined;
      }
    | undefined;
}

export interface ExecutionAttemptContext {
  readonly workItemId: WorkItemId;
  readonly workflowInstanceId: ActivityWorkflowInstanceId;
  readonly orchestrationGroupId: ActivityOrchestrationGroupId;
  readonly resources: readonly ResourceView[];
  readonly owner?: string;
  /** Runner names currently quota-paused; unset means none. */
  readonly ineligibleRunners?: ReadonlySet<string>;
}
