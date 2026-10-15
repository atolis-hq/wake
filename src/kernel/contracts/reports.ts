import { defineClosedVocabulary, type ValueOf } from './vocabulary.js';

export const ReportWindowId = defineClosedVocabulary({
  Day: '1d',
  ThreeDays: '3d',
  FiveDays: '5d',
  Week: '7d',
} as const);

export type ReportWindowId = ValueOf<typeof ReportWindowId>;

export interface ReportWindow {
  readonly id: ReportWindowId;
  readonly from: string;
  readonly to: string;
  readonly bucketMs: number;
}

export interface ReportQuery {
  readonly window: ReportWindow;
  readonly signal?: AbortSignal;
}

export interface ReportDescriptor {
  readonly id: string;
  readonly title: string;
}

export interface TimeSeriesReport {
  readonly durationRows?: readonly {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly completedAt: string;
    readonly durationMs: number;
  }[];
  readonly excludedDurationCount?: number;
  readonly report: ReportDescriptor;
  readonly window: ReportWindow;
  readonly series: readonly (ReportDescriptor & { readonly unit?: string })[];
  readonly totals: Readonly<Record<string, number>>;
  readonly buckets: readonly {
    readonly from: string;
    readonly to: string;
    readonly values: Readonly<Record<string, number>>;
  }[];
}

export interface BreakdownReport {
  readonly report: ReportDescriptor;
  readonly window: ReportWindow;
  readonly total: number;
  readonly dimensions: readonly (ReportDescriptor & {
    readonly rows: readonly {
      readonly value: string;
      readonly count: number;
      readonly share: number;
      readonly tokens: number;
      readonly costUsd: number;
      readonly durationMs: number;
      readonly tokenRuns: number;
      readonly costRuns: number;
      readonly durationRuns: number;
    }[];
  })[];
}

export interface DurationStatistics {
  readonly count: number;
  readonly medianMs: number | null;
  readonly averageMs: number | null;
}

export interface DurationReport {
  readonly report: ReportDescriptor;
  readonly window: ReportWindow;
  readonly statistics: DurationStatistics;
  readonly groups: readonly (ReportDescriptor & {
    readonly rows: readonly (DurationStatistics & { readonly value: string })[];
  })[];
  readonly buckets: readonly (DurationStatistics & {
    readonly from: string;
    readonly to: string;
  })[];
}

export type AnalyticsReport = TimeSeriesReport | BreakdownReport | DurationReport;

export interface ReportDefinition extends ReportDescriptor {
  query(query: ReportQuery): Promise<AnalyticsReport>;
}

export function reportWindow(id: ReportWindowId, now: string): ReportWindow {
  const day = 24 * 60 * 60 * 1000;
  const days = {
    [ReportWindowId.Day]: 1,
    [ReportWindowId.ThreeDays]: 3,
    [ReportWindowId.FiveDays]: 5,
    [ReportWindowId.Week]: 7,
  }[id];
  const rolling = days <= 3;
  const to = rolling ? Date.parse(now) : Math.floor(Date.parse(now) / day) * day;
  return {
    id,
    from: new Date(to - days * day).toISOString(),
    to: new Date(to).toISOString(),
    bucketMs: days === 1 ? day / 24 : days === 3 ? day / 4 : day,
  };
}

/** Exact median with bounded sorting/merging work between caller-supplied pauses. */
export async function median(
  values: readonly number[],
  pause: () => Promise<void>,
): Promise<number | null> {
  if (values.length === 0) return null;
  const batchSize = 1024;
  let sorted: number[] = [];
  for (let start = 0; start < values.length; start += batchSize) {
    await pause();
    sorted.push(...values.slice(start, start + batchSize).sort((a, b) => a - b));
  }
  for (let width = batchSize; width < values.length; width *= 2) {
    const merged: number[] = [];
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = Math.min(start + width, values.length),
        end = Math.min(start + width * 2, values.length);
      let left = start,
        right = middle;
      while (left < middle || right < end) {
        if (merged.length % batchSize === 0) await pause();
        if (right === end || (left < middle && sorted[left]! <= sorted[right]!))
          merged.push(sorted[left++]!);
        else merged.push(sorted[right++]!);
      }
    }
    sorted = merged;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
