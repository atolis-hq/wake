import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';

export const WorkflowDiagramStatus = defineClosedVocabulary({
  Active: 'active',
  Waiting: 'waiting',
  Blocked: 'blocked',
  Completed: 'completed',
} as const);

export type WorkflowDiagramStatus = ValueOf<typeof WorkflowDiagramStatus>;

const workflowDiagramChildKindShape = {
  activity: true,
  watch: true,
  'watch-gate': true,
  reactor: true,
} as const;
type WorkflowDiagramChildKindValue = keyof typeof workflowDiagramChildKindShape;
const workflowDiagramChildKinds = Object.keys(
  workflowDiagramChildKindShape,
) as readonly WorkflowDiagramChildKindValue[];

export const WorkflowDiagramChildKind = {
  Activity: workflowDiagramChildKinds[0]!,
  Watch: workflowDiagramChildKinds[1]!,
  WatchGate: workflowDiagramChildKinds[2]!,
  Reactor: workflowDiagramChildKinds[3]!,
} as const satisfies Record<string, WorkflowDiagramChildKindValue>;

export type WorkflowDiagramChildKind = ValueOf<typeof WorkflowDiagramChildKind>;

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
