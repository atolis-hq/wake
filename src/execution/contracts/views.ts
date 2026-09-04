import type {
  ActivationId,
  ActivityName,
  ActivityOrchestrationGroupId,
  ActivityOutcome,
  ActivityWorkflowInstanceId,
} from '../../activities/index.js';
import type { RunId } from './identifiers.js';
import type { Cancellation, ExternalExecutionReference, Lease } from './liveness.js';
import type { ExecutionFailure } from './results.js';
import type { AgentRunResponse } from './runner.js';
import type { WorkspaceMode } from './vocabulary.js';
import { type RunStatus } from './vocabulary.js';

export type RunTransportStatus = RunStatus;

export interface RunView {
  readonly runId: RunId;
  readonly activationId: ActivationId;
  readonly activity: ActivityName;
  readonly stage?: string | undefined;
  readonly workflowInstanceId: ActivityWorkflowInstanceId;
  readonly orchestrationGroupId: ActivityOrchestrationGroupId;
  readonly attempt: number;
  readonly status: RunTransportStatus;
  /** Unknown-state inspection count; only terminal ambiguity is escalated. */
  readonly ambiguityAttempts: number;
  readonly escalated: boolean;
  readonly startedAt: string;
  readonly executionStartedAt?: string | undefined;
  readonly runner?:
    | {
        readonly name: string;
        readonly model?: string | undefined;
        readonly effort?: string | undefined;
        readonly pool?: string | undefined;
        readonly cli?: string | undefined;
      }
    | undefined;
  readonly finishedAt?: string;
  readonly outcome?: ActivityOutcome;
  readonly failure?: ExecutionFailure;
  readonly workspace?: {
    readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
    readonly path: string;
    readonly branch?: string | undefined;
  };
  readonly lease?: Lease;
  readonly externalExecution?: ExternalExecutionReference;
  readonly agent?: AgentRunResponse | undefined;
  readonly cancellation?: Cancellation;
}
