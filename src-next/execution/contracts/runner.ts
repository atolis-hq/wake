import type { ExternalExecutionKind } from '../../activities/index.js';
import type { FinishedRunStatus } from './vocabulary.js';

export interface RunnerRequest {
  readonly runId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly workspacePath?: string;
  readonly allowedTools: readonly string[];
  readonly maxTurns?: number;
  readonly resumeSessionId?: string;
}

export type AgentRunOutcome = 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';

export interface AgentRunResponse {
  readonly outcome: AgentRunOutcome;
  readonly displayBody: string;
  readonly artifacts?: readonly {
    readonly kind: string;
    readonly externalKey: { readonly adapter: string; readonly key: string };
  }[] | undefined;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}
export interface AgentRunnerResult {
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
  readonly result: Promise<AgentRunnerResult>;
  cancel(reason: string): Promise<void>;
}

export interface Runner {
  start(request: RunnerRequest, signal: AbortSignal): Promise<RunnerExecution>;
}
