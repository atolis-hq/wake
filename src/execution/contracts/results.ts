import type { ActivityOutcome } from '../../activities/index.js';
import type { AgentRunResponse } from './runner.js';
import type { ExecutionFailureCode, RunStatus } from './vocabulary.js';

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

export interface RecordedRunnerResult {
  readonly transport:
    | typeof RunStatus.Succeeded
    | typeof RunStatus.Failed
    | typeof RunStatus.Cancelled
    | typeof RunStatus.Ambiguous;
  /** Legacy decode-only compatibility. New execution facts never set these fields. */
  readonly output?: string | undefined;
  readonly runner?: string | undefined;
  readonly agent?: AgentRunResponse | undefined;
}

export interface RecoveredRunResult {
  readonly result: RecordedRunnerResult;
  readonly outcome: ActivityOutcome;
  readonly finishedAt: string;
}
