import type { ActivityOutcome, ExternalExecutionKind } from '../../activities/index.js';
import type { RecordedRunnerResult } from './events.js';
import type { ExecutionCancellationReason } from './vocabulary.js';

export interface Lease {
  readonly owner: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface ExternalExecutionReference {
  readonly kind: typeof ExternalExecutionKind.Process | typeof ExternalExecutionKind.RemoteSession;
  readonly id: string;
  readonly startedAt: string;
}

export interface Cancellation {
  readonly requestedAt: string;
  readonly reason: ExecutionCancellationReason;
  readonly confirmedAt?: string;
}

export interface RecoveredRunResult {
  readonly result: RecordedRunnerResult;
  readonly outcome: ActivityOutcome;
  readonly finishedAt: string;
}
