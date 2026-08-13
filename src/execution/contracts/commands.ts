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
  readonly stage?: string | undefined;
  readonly input: unknown;
  readonly execution:
    | {
        readonly workspace?: WorkspaceMode | undefined;
        readonly runnerPool?: string | undefined;
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
  /** Watch workflows always start fresh; primary stages resume their own compatible session. */
  readonly sessionPolicy?: 'fresh' | 'resume-stage';
  /** Let a control-plane tick observe an immediate deterministic completion before returning. */
  readonly awaitImmediateCompletion?: boolean;
}
