import type { ExternalExecutionKind } from '../../activities/index.js';
import type { FinishedRunStatus, WorkspaceMode } from './vocabulary.js';

export const ProviderQuotaExceededFailureKind = 'provider-quota-exceeded';

export interface RunnerRequest {
  readonly runId: string;
  readonly prompt: string;
  readonly context?: {
    readonly runnerName: string;
    readonly action: string;
    readonly activationOrdinal: number;
  };
  readonly model?: string;
  readonly effort?: string;
  readonly workspacePath?: string;
  readonly workspaceMode?: Exclude<WorkspaceMode, typeof WorkspaceMode.None>;
  readonly allowedTools: readonly string[];
  readonly maxTurns?: number;
  readonly onTimeout?: (kind: 'idle' | 'hard') => Promise<void>;
  readonly resumeSessionId?: string;
  readonly usageBaseline?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
}

export type AgentRunOutcome = 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';

export interface AgentRunResponse {
  readonly outcome: AgentRunOutcome;
  readonly displayBody: string;
  readonly artifacts?:
    | readonly {
        readonly kind: string;
        readonly externalKey: { readonly adapter: string; readonly key: string };
      }[]
    | undefined;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AgentTokenUsage {
  readonly tokens: number;
  readonly costUsd: number;
}

// inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/costUsd are the known
// numeric keys agent-runner-adapter.ts writes into AgentRunResponse.metadata.
export function agentTokenUsage(
  metadata: AgentRunResponse['metadata'] | undefined,
): AgentTokenUsage {
  const numeric = (key: string): number => {
    const value = metadata?.[key];
    return typeof value === 'number' ? value : 0;
  };
  return {
    tokens:
      numeric('inputTokens') +
      numeric('outputTokens') +
      numeric('cacheReadTokens') +
      numeric('cacheWriteTokens'),
    costUsd: numeric('costUsd'),
  };
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
  /** Whether this adapter can continue an earlier session with its opaque session ID. */
  readonly supportsSessionResume?: boolean;
  start(request: RunnerRequest, signal: AbortSignal): Promise<RunnerExecution>;
}
