import type { ReportWindow } from '../../../kernel/index.js';

export interface AnalyticsWindowResponse {
  readonly days: number;
  readonly from: string;
  readonly to: string;
}

export interface MetricsResponse {
  readonly collectedAt: string;
  readonly window: AnalyticsWindowResponse;
  readonly values: Readonly<Record<string, number>>;
}

export { ReportWindowId } from '../../../kernel/index.js';

export type {
  AnalyticsReport,
  ReportWindowId as AnalyticsReportWindowId,
  BreakdownReport,
  DurationReport,
  DurationStatistics,
  ReportDescriptor,
  ReportWindow,
  TimeSeriesReport,
} from '../../../kernel/index.js';

export interface AnalyticsSummaryResponse {
  readonly window: ReportWindow;
  readonly runs: number;
  readonly completed: number;
  readonly blockedOrAwaitingApproval: number;
  readonly failed: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly medianRunDurationMs: number | null;
  readonly workItemsDone: number;
  readonly acceptedChildResults: number;
  readonly correctiveActivations: number;
  readonly medianEndToEndDurationMs: number | null;
}
