import { yieldScan } from '@atolis-hq/eventing';
import {
  median,
  type DurationReport,
  type ReportDescriptor,
  type ReportQuery,
  type TimeSeriesReport,
} from '../../kernel/index.js';
import { RunReportValue } from '../contracts/run-report-value.js';
import type { RunView } from '../contracts/views.js';

export function runDuration(run: RunView): number | null {
  if (run.finishedAt === undefined) return null;
  const duration = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function collectDurations(
  query: ReportQuery,
  buckets: TimeSeriesReport['buckets'],
  dimensions: readonly {
    readonly id: string;
    readonly title: string;
    readonly value: (run: RunView) => string | undefined;
  }[],
  durationDescriptor: ReportDescriptor,
) {
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
