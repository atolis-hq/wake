import { WorkspaceMode, type ExecutionFailureCode, type RunStatus } from './vocabulary.js';
import type {
  ActivationId,
  ActivityName,
  ActivityOrchestrationGroupId,
  ActivityOutcome,
  ActivityWorkflowInstanceId,
} from '../../activities/index.js';
import type { RunId } from './identifiers.js';
export type RunTransportStatus = RunStatus;

export interface ExecutionFailure {
  readonly kind: ExecutionFailureCode;
  readonly message: string;
  readonly details?:
    | {
        readonly sourceKind: string;
        readonly sourceDetails?: unknown;
      }
    | undefined;
}

export interface RunView {
  readonly runId: RunId;
  readonly activationId: ActivationId;
  readonly activity: ActivityName;
  readonly workflowInstanceId: ActivityWorkflowInstanceId;
  readonly orchestrationGroupId: ActivityOrchestrationGroupId;
  readonly attempt: number;
  readonly status: RunTransportStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: ActivityOutcome;
  readonly failure?: ExecutionFailure;
  readonly workspace?: {
    readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
    readonly path: string;
  };
}
