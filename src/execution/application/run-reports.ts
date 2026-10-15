import { scanJournal, yieldScan, type EventJournal } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import {
  defineClosedVocabulary,
  median,
  type BreakdownReport,
  type DurationReport,
  type ReportDefinition,
  type ReportQuery,
  type TimeSeriesReport,
  type ValueOf,
} from '../../kernel/index.js';
import { selectRunExecutionEvent } from '../contracts/events.js';
import { agentTokenUsage } from '../contracts/runner.js';
import type { RunView } from '../contracts/views.js';
import { RunStatus } from '../contracts/vocabulary.js';
import { foldRunEvent } from '../domain/run.js';

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
} as const);

export const RunReportValue = defineClosedVocabulary({ Unknown: 'unknown' } as const);
const dimensions = [
  { id: RunReportDimension.Action, title: 'Action', value: (run: RunView) => run.activity },
  { id: RunReportDimension.Stage, title: 'Stage', value: (run: RunView) => run.stage },
  { id: RunReportDimension.Runner, title: 'Runner', value: (run: RunView) => run.runner?.name },
  { id: RunReportDimension.Model, title: 'Model', value: (run: RunView) => run.runner?.model },
];

export function createRunBreakdownReport(journal: EventJournal): ReportDefinition {
  return {
    id: RunReportId.Breakdown,
    title: 'Run breakdowns by dimension',
    query: async (query) => (await queryRunAnalytics(journal, query)).breakdown,
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
): Promise<{
  duration: DurationReport;
  report: TimeSeriesReport;
  breakdown: BreakdownReport;
  usage: TimeSeriesReport;
  summary: RunSummary;
}> {
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
  const durationData = collectDurations(query, buckets);
  const counts = dimensions.map(() => new Map<string, number>());
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
    dimensions.forEach((dimension, index) => {
      const value = dimension.value(run) ?? RunReportValue.Unknown;
      const groups = counts[index]!;
      groups.set(value, (groups.get(value) ?? 0) + 1);
    });
    const usage = agentTokenUsage(run.agent?.metadata);
    const tokens = finiteOrZero(usage.tokens);
    const cost = finiteOrZero(usage.costUsd);
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

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function runDuration(run: RunView): number | null {
  if (run.finishedAt === undefined) return null;
  const duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
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
  counts: readonly Map<string, number>[],
): BreakdownReport {
  return {
    report: { id: RunReportId.Breakdown, title: 'Run breakdowns by dimension' },
    window: query.window,
    total: runs,
    dimensions: dimensions.map(({ id, title }, index) => ({
      id,
      title,
      rows: [...counts[index]!.entries()]
        .sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : a > b ? 1 : 0))
        .map(([value, count]) => ({ value, count, share: count / runs })),
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

function collectDurations(query: ReportQuery, buckets: TimeSeriesReport['buckets']) {
  const durations: number[] = [];
  const durationBuckets = buckets.map(() => [] as number[]);
  const durationGroups = dimensions.slice(0, 2).map(() => new Map<string, number[]>());
  return {
    add(run: RunView, bucketIndex: number) {
      const duration = runDuration(run);
      if (duration !== null) {
        durations.push(duration);
        durationBuckets[bucketIndex]!.push(duration);
        dimensions.slice(0, 2).forEach((dimension, index) => {
          const value = dimension.value(run) ?? RunReportValue.Unknown;
          const groups = durationGroups[index]!;
          const values = groups.get(value) ?? [];
          values.push(duration);
          groups.set(value, values);
        });
      }
    },
    async report(): Promise<DurationReport> {
      const statistics = async (values: readonly number[]) => {
        let sum = 0;
        for (const [index, value] of values.entries()) {
          if (index % 1024 === 0) await yieldScan(query.signal);
          sum += value;
        }
        return {
          count: values.length,
          medianMs: await median(values, () => yieldScan(query.signal)),
          averageMs: values.length === 0 ? null : sum / values.length,
        };
      };
      const groups: DurationReport['groups'][number][] = [];
      for (const [index, dimension] of dimensions.slice(0, 2).entries()) {
        const rows = [];
        for (const [value, values] of durationGroups[index]!) {
          await yieldScan(query.signal);
          rows.push({ value, ...(await statistics(values)) });
        }
        rows.sort(
          (a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
        );
        groups.push({ id: dimension.id, title: dimension.title, rows });
      }
      const durationSeries = [];
      for (const [index, bucket] of buckets.entries()) {
        durationSeries.push({
          from: bucket.from,
          to: bucket.to,
          ...(await statistics(durationBuckets[index]!)),
        });
      }

      return {
        report: durationDescriptor,
        window: query.window,
        statistics: await statistics(durations),
        groups,
        buckets: durationSeries,
      };
    },
  };
}
