import { scanJournal, yieldScan, type EventJournal } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import {
  defineClosedVocabulary,
  type BreakdownReport,
  type DurationReport,
  type ReportDefinition,
  type ReportQuery,
  type TimeSeriesReport,
  type ValueOf,
} from '../../kernel/index.js';
import { selectRunExecutionEvent } from '../contracts/events.js';
import { RunReportValue } from '../contracts/run-report-value.js';
import type { RunView } from '../contracts/views.js';
import { RunStatus } from '../contracts/vocabulary.js';
import { foldRunEvent } from '../domain/run.js';
import { collectDurations } from './run-duration.js';
import { runBreakdownMetrics } from './run-metrics.js';

export const RunReportId = defineClosedVocabulary({
  Duration: 'run-duration',
  Outcomes: 'run-outcomes-over-time',
  Usage: 'token-and-cost-usage',
  Breakdown: 'run-breakdowns-by-dimension',
} as const);

const durationDescriptor = { id: RunReportId.Duration, title: 'Run duration' };

export function createRunDurationReport(journal: EventJournal): ReportDefinition {
  return {
    ...durationDescriptor,
    query: async (query) => (await queryRunAnalytics(journal, query)).duration,
  };
}

export const RunUsageMeasure = defineClosedVocabulary({
  Tokens: 'total-tokens',
  CostUsd: 'total-cost-usd',
} as const);
const usageSeries = [
  { id: RunUsageMeasure.Tokens, title: 'Total tokens', unit: 'tokens' },
  { id: RunUsageMeasure.CostUsd, title: 'Total cost (USD)', unit: 'USD' },
];
const usageDescriptor = { id: RunReportId.Usage, title: 'Token and cost usage' };

export function createRunUsageReport(journal: EventJournal): ReportDefinition {
  return {
    ...usageDescriptor,
    query: async (query) => (await queryRunAnalytics(journal, query)).usage,
  };
}

export const RunReportDimension = defineClosedVocabulary({
  Action: 'run-action',
  Stage: 'run-stage',
  Runner: 'run-runner',
  Model: 'run-model',
  Repository: 'run-repository',
  RunnerPool: 'run-runner-pool',
} as const);

export { RunReportValue } from '../contracts/run-report-value.js';
const dimensions = [
  { id: RunReportDimension.Action, title: 'Action', value: (run: RunView) => run.activity },
  { id: RunReportDimension.Stage, title: 'Stage', value: (run: RunView) => run.stage },
  { id: RunReportDimension.Runner, title: 'Runner', value: (run: RunView) => run.runner?.name },
  { id: RunReportDimension.Model, title: 'Model', value: (run: RunView) => run.runner?.model },
  {
    id: RunReportDimension.Repository,
    title: 'Repository',
    value: (_run: RunView): string | undefined => undefined,
  },
  {
    id: RunReportDimension.RunnerPool,
    title: 'Runner pool',
    value: (run: RunView) => run.runner?.pool,
  },
];

export type RunRepositoryLookup = (
  query: ReportQuery,
) => Promise<(run: RunView) => string | undefined>;

export function createRunBreakdownReport(
  journal: EventJournal,
  repositories?: RunRepositoryLookup,
): ReportDefinition {
  return {
    id: RunReportId.Breakdown,
    title: 'Run breakdowns by dimension',
    query: async (query) => (await queryRunAnalytics(journal, query, repositories)).breakdown,
  };
}

export const RunReportOutcome = defineClosedVocabulary({
  Completed: 'completed',
  Blocked: 'blocked',
  AwaitingApproval: 'awaiting-approval',
  Failed: 'failed',
  Other: 'other',
} as const);

export type RunReportOutcome = ValueOf<typeof RunReportOutcome>;
const series = [
  { id: RunReportOutcome.Completed, title: 'Completed' },
  { id: RunReportOutcome.Blocked, title: 'Blocked' },
  { id: RunReportOutcome.AwaitingApproval, title: 'Awaiting approval' },
  { id: RunReportOutcome.Failed, title: 'Failed' },
  { id: RunReportOutcome.Other, title: 'Other' },
];

export interface RunSummary {
  readonly runs: number;
  readonly completed: number;
  readonly blockedOrAwaitingApproval: number;
  readonly failed: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly medianRunDurationMs: number | null;
}

export function runReportOutcome(run: RunView): RunReportOutcome {
  if (run.status === RunStatus.Failed) return RunReportOutcome.Failed;
  if (run.status !== RunStatus.Succeeded) return RunReportOutcome.Other;
  switch (run.outcome?.kind) {
    case ActivityOutcomeKind.Done:
      return RunReportOutcome.Completed;
    case ActivityOutcomeKind.Blocked:
      return RunReportOutcome.Blocked;
    case ActivityOutcomeKind.Waiting:
      return RunReportOutcome.AwaitingApproval;
    case ActivityOutcomeKind.Failed:
    case ActivityOutcomeKind.Rejected:
      return RunReportOutcome.Failed;
    default:
      return RunReportOutcome.Other;
  }
}

export function createRunOutcomesReport(journal: EventJournal): ReportDefinition {
  return {
    id: RunReportId.Outcomes,
    title: 'Run outcomes over time',
    query: async (query) => (await queryRunAnalytics(journal, query)).report,
  };
}

export async function queryRunAnalytics(
  journal: EventJournal,
  query: ReportQuery,
  repositories?: RunRepositoryLookup,
): Promise<{
  duration: DurationReport;
  report: TimeSeriesReport;
  breakdown: BreakdownReport;
  usage: TimeSeriesReport;
  summary: RunSummary;
}> {
  const repositoryForRun = await repositories?.(query);
  const from = Date.parse(query.window.from);
  const to = Date.parse(query.window.to);
  const first = Math.floor(from / query.window.bucketMs) * query.window.bucketMs;
  const buckets = outcomeBuckets(first, to, query.window.bucketMs);
  const usageBuckets = buckets.map(({ from, to }) => ({
    from,
    to,
    values: { [RunUsageMeasure.Tokens]: 0, [RunUsageMeasure.CostUsd]: 0 },
  }));
  const totals = Object.fromEntries(series.map(({ id }) => [id, 0]));
  const durationData = collectDurations(query, buckets, dimensions, durationDescriptor);
  const counts = dimensions.map(() => new Map<string, BreakdownTotals>());
  let runs = 0,
    totalTokens = 0,
    totalCostUsd = 0,
    processed = 0;
  for (const run of (await readRuns(journal, query)).values()) {
    if (processed++ % 100 === 0) await yieldScan(query.signal);
    const start = Date.parse(run.startedAt);
    if (!(start >= from && start < to)) continue;
    const outcome = runReportOutcome(run);
    totals[outcome]!++;
    buckets[Math.floor((start - first) / query.window.bucketMs)]!.values[outcome]!++;
    runs++;
    const metrics = runBreakdownMetrics(run);
    const { tokens, costUsd: cost } = metrics;
    countDimensions(run, counts, metrics, repositoryForRun);
    totalTokens += tokens;
    totalCostUsd += cost;
    const bucket = usageBuckets[Math.floor((start - first) / query.window.bucketMs)]!;
    bucket.values[RunUsageMeasure.Tokens] += tokens;
    bucket.values[RunUsageMeasure.CostUsd] += cost;
    durationData.add(run, Math.floor((start - first) / query.window.bucketMs));
  }
  const duration = await durationData.report();
  query.signal?.throwIfAborted();
  return {
    duration,
    report: {
      report: { id: RunReportId.Outcomes, title: 'Run outcomes over time' },
      window: query.window,
      series,
      totals,
      buckets,
    },
    usage: {
      report: usageDescriptor,
      window: query.window,
      series: usageSeries,
      totals: { [RunUsageMeasure.Tokens]: totalTokens, [RunUsageMeasure.CostUsd]: totalCostUsd },
      buckets: usageBuckets,
    },
    breakdown: runBreakdown(query, runs, counts),
    summary: {
      runs,
      completed: totals[RunReportOutcome.Completed]!,
      blockedOrAwaitingApproval:
        totals[RunReportOutcome.Blocked]! + totals[RunReportOutcome.AwaitingApproval]!,
      failed: totals[RunReportOutcome.Failed]!,
      totalTokens,
      totalCostUsd,
      medianRunDurationMs: duration.statistics.medianMs,
    },
  };
}

async function readRuns(journal: EventJournal, query: ReportQuery) {
  const grouped = new Map<string, RunView>();
  for await (const event of scanJournal(journal, query.signal)) {
    const owned = selectRunExecutionEvent(event);
    if (owned === null) continue;
    grouped.set(owned.stream.id, foldRunEvent(grouped.get(owned.stream.id) ?? null, owned));
  }
  return grouped;
}

function runBreakdown(
  query: ReportQuery,
  runs: number,
  counts: readonly Map<string, BreakdownTotals>[],
): BreakdownReport {
  return {
    report: { id: RunReportId.Breakdown, title: 'Run breakdowns by dimension' },
    window: query.window,
    total: runs,
    dimensions: dimensions.map(({ id, title }, index) => ({
      id,
      title,
      rows: [...counts[index]!.entries()]
        .sort(([a, ac], [b, bc]) => bc.count - ac.count || (a < b ? -1 : a > b ? 1 : 0))
        .map(([value, metrics]) => ({ value, ...metrics, share: metrics.count / runs })),
    })),
  };
}

function outcomeBuckets(first: number, to: number, bucketMs: number) {
  const buckets = [];
  for (let start = first; start < to; start += bucketMs)
    buckets.push({
      from: new Date(start).toISOString(),
      to: new Date(start + bucketMs).toISOString(),
      values: Object.fromEntries(series.map(({ id }) => [id, 0])),
    });
  return buckets;
}

type BreakdownTotals = Omit<
  BreakdownReport['dimensions'][number]['rows'][number],
  'value' | 'share'
>;

function countDimensions(
  run: RunView,
  counts: readonly Map<string, BreakdownTotals>[],
  metrics: BreakdownTotals,
  repositoryForRun?: (run: RunView) => string | undefined,
) {
  dimensions.forEach((dimension, index) => {
    const value =
      (dimension.id === RunReportDimension.Repository
        ? repositoryForRun?.(run)
        : dimension.value(run)) ?? RunReportValue.Unknown;
    const groups = counts[index]!;
    const previous = groups.get(value);
    groups.set(
      value,
      previous === undefined
        ? { ...metrics }
        : {
            count: previous.count + metrics.count,
            tokens: previous.tokens + metrics.tokens,
            costUsd: previous.costUsd + metrics.costUsd,
            durationMs: previous.durationMs + metrics.durationMs,
            tokenRuns: previous.tokenRuns + metrics.tokenRuns,
            costRuns: previous.costRuns + metrics.costRuns,
            durationRuns: previous.durationRuns + metrics.durationRuns,
          },
    );
  });
}
