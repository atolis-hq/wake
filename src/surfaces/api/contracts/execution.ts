export interface RunResponse {
  readonly runId: string;
  readonly activationId: string;
  readonly activity: string;
  readonly workflowInstanceId: string;
  readonly orchestrationGroupId: string;
  readonly attempt: number;
  readonly status: string;
  readonly active: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: unknown;
  readonly failure?: { readonly kind: string };
  readonly sentinel: string;
  /** Present only when the run's own outcome was `waiting` and the delivery it named has since resolved. */
  readonly resolution?: {
    readonly sentinel: 'DONE' | 'FAILED' | 'AMBIGUOUS';
    readonly resolvedAt: string;
  };
  readonly runnerName?: string;
  readonly runnerModel?: string;
  readonly workflowName?: string;
  readonly stage?: string;
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalCostUsd: number;
}

export interface RunTranscriptResponse {
  readonly runId: string;
  readonly groupId?: string;
  readonly available: boolean;
  readonly entries: readonly TranscriptEntryResponse[];
}

export interface TranscriptEntryResponse {
  readonly occurredAt: string;
  readonly channel: TranscriptChannel;
  readonly text: string;
  readonly runId: string;
  readonly groupId: string;
  readonly durationMs?: number;
}

export interface TranscriptGroupResponse {
  readonly groupId: string;
  readonly kind: TranscriptGroupKind;
  readonly cli?: string;
  readonly latestAt: string;
  readonly runIds: readonly string[];
}

export interface WorkItemTranscriptResponse {
  readonly groupId: string;
  readonly available: boolean;
  readonly entries: readonly TranscriptEntryResponse[];
}

export interface RunnerResponse {
  readonly runnerId: string;
  readonly status: string;
  readonly available: boolean;
  readonly detail?: string;
  readonly updatedAt: string;
}
import type { TranscriptChannel, TranscriptGroupKind } from '../../../execution/index.js';
