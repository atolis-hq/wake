export type WorkflowDiagramStatus = 'active' | 'waiting' | 'blocked' | 'completed';

export type WorkflowDiagramChildKind = 'activity' | 'watch' | 'watch-gate' | 'reactor';

export interface WorkflowDiagramMetricsResponse {
  readonly runCount?: number;
  readonly totalDurationMs?: number;
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalCostUsd?: number;
}

export interface WorkflowDiagramActiveRunResponse {
  readonly runId: string;
  readonly activity: string;
  readonly runnerName?: string;
  readonly startedAt: string;
}

export interface WorkflowDiagramChildResponse extends WorkflowDiagramMetricsResponse {
  readonly id: string;
  readonly label: string;
  readonly kind: WorkflowDiagramChildKind;
  readonly status?: WorkflowDiagramStatus;
  readonly lastOutcome?: string;
  readonly activeRuns?: readonly WorkflowDiagramActiveRunResponse[];
}

export interface WorkflowDiagramStageResponse extends WorkflowDiagramMetricsResponse {
  readonly id: string;
  readonly label: string;
  readonly status?: WorkflowDiagramStatus;
  readonly lastOutcome?: string;
  readonly activeRuns?: readonly WorkflowDiagramActiveRunResponse[];
  readonly children: readonly WorkflowDiagramChildResponse[];
}

export interface WorkflowDiagramTransitionResponse {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly fromChildId?: string;
}

/** A compiled workflow projection with an optional overlay for one work item. */
export interface WorkflowDiagramResponse {
  readonly id: string;
  readonly label: string;
  readonly direction: 'left-to-right';
  readonly stages: readonly WorkflowDiagramStageResponse[];
  readonly transitions: readonly WorkflowDiagramTransitionResponse[];
}

export interface WorkflowDiagramsResponse {
  readonly diagrams: readonly WorkflowDiagramResponse[];
}
