import {
  ReportWindowId,
  type AnalyticsReport,
  type AnalyticsSummaryResponse,
  type DurationStatistics,
  type ReportDescriptor,
  type ReportWindow,
} from '../../../api/contracts/index.js';
import {
  array,
  child,
  invalid,
  number,
  object,
  string,
  type Decoder,
} from './decoder-primitives.js';

export const decodeReportDescriptor: Decoder<ReportDescriptor> = (value, path = '') => {
  const record = object(value, path);
  return {
    id: string(record.id, child(path, 'id')),
    title: string(record.title, child(path, 'title')),
  };
};

export const decodeReportCatalogue: Decoder<readonly ReportDescriptor[]> = (value, path = '') =>
  array(value, path, decodeReportDescriptor);

function decodeWindow(value: unknown, path: string): ReportWindow {
  const record = object(value, path);
  const id = Object.values(ReportWindowId).find((id) => id === record.id);
  if (id === undefined) invalid(child(path, 'id'));
  return {
    id,
    from: string(record.from, child(path, 'from')),
    to: string(record.to, child(path, 'to')),
    bucketMs: number(record.bucketMs, child(path, 'bucketMs')),
  };
}

function decodeValues(value: unknown, path: string) {
  return Object.fromEntries(
    Object.entries(object(value, path)).map(([key, item]) => [key, number(item, child(path, key))]),
  );
}

export const decodeReport: Decoder<AnalyticsReport> = (value, path = '') => {
  const record = object(value, path);
  if ('statistics' in record) {
    const statistics: Decoder<DurationStatistics> = (value, path = '') => {
      const row = object(value, path);
      const nullable = (key: string) =>
        row[key] === null ? null : number(row[key], child(path, key));
      return {
        count: number(row.count, child(path, 'count')),
        medianMs: nullable('medianMs'),
        averageMs: nullable('averageMs'),
      };
    };
    return {
      report: decodeReportDescriptor(record.report, child(path, 'report')),
      window: decodeWindow(record.window, child(path, 'window')),
      statistics: statistics(record.statistics, child(path, 'statistics')),
      groups: array(record.groups, child(path, 'groups'), (value, path = '') => {
        const group = object(value, path);
        return {
          ...decodeReportDescriptor(value, path),
          rows: array(group.rows, child(path, 'rows'), (value, path = '') => {
            const row = object(value, path);
            return { value: string(row.value, child(path, 'value')), ...statistics(value, path) };
          }),
        };
      }),
      buckets: array(record.buckets, child(path, 'buckets'), (value, path = '') => {
        const bucket = object(value, path);
        return {
          from: string(bucket.from, child(path, 'from')),
          to: string(bucket.to, child(path, 'to')),
          ...statistics(value, path),
        };
      }),
    };
  }
  if ('dimensions' in record)
    return {
      report: decodeReportDescriptor(record.report, child(path, 'report')),
      window: decodeWindow(record.window, child(path, 'window')),
      total: number(record.total, child(path, 'total')),
      dimensions: array(record.dimensions, child(path, 'dimensions'), (value, path = '') => {
        const dimension = object(value, path);
        return {
          ...decodeReportDescriptor(value, path),
          rows: array(dimension.rows, child(path, 'rows'), (value, path = '') => {
            const row = object(value, path);
            return {
              value: string(row.value, child(path, 'value')),
              count: number(row.count, child(path, 'count')),
              share: number(row.share, child(path, 'share')),
            };
          }),
        };
      }),
    };
  return {
    report: decodeReportDescriptor(record.report, child(path, 'report')),
    window: decodeWindow(record.window, child(path, 'window')),
    series: array(record.series, child(path, 'series'), (value, path = '') => {
      const series = object(value, path);
      return {
        ...decodeReportDescriptor(value, path),
        ...(series.unit === undefined ? {} : { unit: string(series.unit, child(path, 'unit')) }),
      };
    }),
    ...(record.durationRows === undefined
      ? {}
      : {
          durationRows: array(
            record.durationRows,
            child(path, 'durationRows'),
            (value, path = '') => {
              const row = object(value, path);
              return {
                ...decodeReportDescriptor(value, path),
                createdAt: string(row.createdAt, child(path, 'createdAt')),
                completedAt: string(row.completedAt, child(path, 'completedAt')),
                durationMs: number(row.durationMs, child(path, 'durationMs')),
              };
            },
          ),
          excludedDurationCount: number(
            record.excludedDurationCount,
            child(path, 'excludedDurationCount'),
          ),
        }),
    totals: decodeValues(record.totals, child(path, 'totals')),
    buckets: array(record.buckets, child(path, 'buckets'), (value, path = '') => {
      const bucket = object(value, path);
      return {
        from: string(bucket.from, child(path, 'from')),
        to: string(bucket.to, child(path, 'to')),
        values: decodeValues(bucket.values, child(path, 'values')),
      };
    }),
  };
};
const summaryFieldShape = { completed: true, failed: true };
const summaryFieldNames = Object.keys(summaryFieldShape);
const summaryField = { Completed: summaryFieldNames[0]!, Failed: summaryFieldNames[1]! } as const;

export const decodeSummary: Decoder<AnalyticsSummaryResponse> = (value, path = '') => {
  const record = object(value, path);
  const metric = (name: string) => number(record[name], child(path, name));
  const duration = (name: string) => (record[name] === null ? null : metric(name));
  return {
    window: decodeWindow(record.window, child(path, 'window')),
    runs: metric('runs'),
    completed: metric(summaryField.Completed),
    blockedOrAwaitingApproval: metric('blockedOrAwaitingApproval'),
    failed: metric(summaryField.Failed),
    totalTokens: metric('totalTokens'),
    totalCostUsd: metric('totalCostUsd'),
    medianRunDurationMs: duration('medianRunDurationMs'),
    workItemsDone: metric('workItemsDone'),
    medianEndToEndDurationMs: duration('medianEndToEndDurationMs'),
  };
};
