import { scanJournal, yieldScan, type EventJournal } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import {
  defineClosedVocabulary,
  median,
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

export const RunReportId = defineClosedVocabulary({ Outcomes: 'run-outcomes-over-time' } as const);

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
): Promise<{ report: TimeSeriesReport; summary: RunSummary }> {
  const grouped = new Map<string, RunView>();
  for await (const event of scanJournal(journal, query.signal)) {
    const owned = selectRunExecutionEvent(event);
    if (owned === null) continue;
    grouped.set(owned.stream.id, foldRunEvent(grouped.get(owned.stream.id) ?? null, owned));
  }
  const from = Date.parse(query.window.from);
  const to = Date.parse(query.window.to);
  const first = Math.floor(from / query.window.bucketMs) * query.window.bucketMs;
  const zero = () => Object.fromEntries(series.map(({ id }) => [id, 0]));
  const buckets = [];
  for (let start = first; start < to; start += query.window.bucketMs)
    buckets.push({
      from: new Date(start).toISOString(),
      to: new Date(start + query.window.bucketMs).toISOString(),
      values: zero(),
    });
  const totals = zero();
  const durations: number[] = [];
  let runs = 0,
    totalTokens = 0,
    totalCostUsd = 0,
    processed = 0;
  for (const run of grouped.values()) {
    if (processed++ % 100 === 0) await yieldScan(query.signal);
    const start = Date.parse(run.startedAt);
    if (!(start >= from && start < to)) continue;
    const outcome = runReportOutcome(run);
    totals[outcome]!++;
    buckets[Math.floor((start - first) / query.window.bucketMs)]!.values[outcome]!++;
    runs++;
    const usage = agentTokenUsage(run.agent?.metadata);
    totalTokens += finiteOrZero(usage.tokens);
    totalCostUsd += finiteOrZero(usage.costUsd);
    const duration = runDuration(run);
    if (duration !== null) durations.push(duration);
  }
  query.signal?.throwIfAborted();
  return {
    report: {
      report: { id: RunReportId.Outcomes, title: 'Run outcomes over time' },
      window: query.window,
      series,
      totals,
      buckets,
    },
    summary: {
      runs,
      completed: totals[RunReportOutcome.Completed]!,
      blockedOrAwaitingApproval:
        totals[RunReportOutcome.Blocked]! + totals[RunReportOutcome.AwaitingApproval]!,
      failed: totals[RunReportOutcome.Failed]!,
      totalTokens,
      totalCostUsd,
      medianRunDurationMs: await median(durations, () => yieldScan(query.signal)),
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
