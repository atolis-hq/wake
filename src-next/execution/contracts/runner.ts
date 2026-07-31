import type { FinishedRunStatus } from './vocabulary.js';
import type { ExternalExecutionKind } from '../../activities/index.js';
export interface RunnerRequest {
  readonly runId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly workspacePath?: string;
  readonly allowedTools: readonly string[];
  readonly resumeSessionId?: string;
}

export interface RunnerResult {
  readonly transport: FinishedRunStatus;
  readonly output: string;
  readonly runner: string;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly tokenUsage?:
    | {
        readonly input: number;
        readonly output: number;
        readonly cacheRead?: number | undefined;
        readonly cacheWrite?: number | undefined;
        readonly costUsd?: number | undefined;
      }
    | undefined;
  readonly failure?: { readonly kind: string; readonly message: string } | undefined;
}

export interface RunnerExecution {
  readonly identity?: {
    readonly kind: ExternalExecutionKind;
    readonly id: string;
    readonly startedAt: string;
  };
  readonly result: Promise<RunnerResult>;
  cancel(reason: string): Promise<void>;
}

export interface Runner {
  start(request: RunnerRequest, signal: AbortSignal): Promise<RunnerExecution>;
}
