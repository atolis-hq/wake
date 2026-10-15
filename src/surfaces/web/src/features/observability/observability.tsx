import { useQuery } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import {
  ReportWindowId,
  type AnalyticsSummaryResponse,
  type BreakdownReport,
  type TimeSeriesReport,
} from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '../../components/primitives.js';
import { Tile } from '../../components/tile.js';
import styles from '../features.module.css';
import reportStyles from './observability.module.css';

export function ObservabilityPage() {
  const [tab, setTab] = useState('reports');
  const tabs = [
    ['reports', 'Reports'],
    ['activity', 'System activity'],
  ] as const;
  const navigate = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'reports'
        : event.key === 'End'
          ? 'activity'
          : tab === 'reports'
            ? 'activity'
            : 'reports';
    setTab(next);
    document.getElementById(`analytics-${next}-tab`)?.focus();
  };
  return (
    <>
      <PageHeader />
      <div className={styles.tabs} role="tablist" aria-label="Analytics sections">
        {tabs.map(([id, title]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`analytics-${id}-tab`}
            aria-controls={`analytics-${id}-panel`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={navigate}
          >
            {title}
          </button>
        ))}
      </div>
      <section
        className={styles.tabPanel}
        role="tabpanel"
        id={`analytics-${tab}-panel`}
        aria-labelledby={`analytics-${tab}-tab`}
      >
        {tab === 'reports' ? <Reports /> : <SystemActivity />}
      </section>
    </>
  );
}
function SystemActivity() {
  const client = useApiClient();
  const query = useQuery({
    queryKey: queryKeys.observability.metrics(1),
    queryFn: ({ signal }) => client.observability.metrics(1, signal),
    refetchInterval: refreshPolicy.observability,
  });
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
        Refresh metrics
      </Button>
      {query.isPending ? (
        <LoadingState label="Loading metrics" />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className={styles.tiles}>
          {Object.entries(query.data.data.values).map(([name, value]) => (
            <Tile key={name} label={name} value={String(value)} />
          ))}
        </div>
      )}
    </>
  );
}
function Reports() {
  const client = useApiClient();
  const [window, setWindow] = useState<ReportWindowId>(ReportWindowId.Day);
  const [selected, setSelected] = useState<string>();
  const catalogue = useQuery({
    queryKey: ['observability', 'reports'],
    queryFn: ({ signal }) => client.observability.reports(signal),
  });
  const reportId = selected ?? catalogue.data?.data[0]?.id;
  const summary = useQuery({
    queryKey: ['observability', 'summary', window, reportId],
    queryFn: ({ signal }) => client.observability.summary(window, signal),
    enabled: reportId !== undefined,
  });
  const report = useQuery({
    queryKey: ['observability', 'report', window, reportId],
    queryFn: ({ signal }) => client.observability.report(window, reportId!, signal),
    enabled: reportId !== undefined,
  });
  return (
    <>
      <div className={reportStyles.controls}>
        <label>
          Window{' '}
          <select
            value={window}
            onChange={(event) => {
              const id = Object.values(ReportWindowId).find((id) => id === event.target.value);
              if (id !== undefined) setWindow(id);
            }}
          >
            {Object.values(ReportWindowId).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Report{' '}
          <select
            value={reportId ?? ''}
            onChange={(event) => setSelected(event.target.value)}
            disabled={catalogue.isPending}
          >
            {catalogue.data?.data.map(({ id, title }) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {catalogue.isPending ? (
        <LoadingState label="Loading reports" />
      ) : catalogue.error ? (
        <ErrorState error={catalogue.error} retry={() => void catalogue.refetch()} />
      ) : catalogue.data.data.length === 0 ? (
        <EmptyState>No reports registered</EmptyState>
      ) : (
        <>
          <section aria-label="Summary tiles">
            {summary.isPending ? (
              <LoadingState label="Loading summary" />
            ) : summary.error ? (
              <ErrorState error={summary.error} retry={() => void summary.refetch()} />
            ) : (
              <Summary data={summary.data.data} />
            )}
          </section>
          <section aria-label="Selected report">
            {report.isPending ? (
              <LoadingState label="Loading report" />
            ) : report.error ? (
              <ErrorState error={report.error} retry={() => void report.refetch()} />
            ) : 'dimensions' in report.data.data ? (
              <BreakdownTable data={report.data.data} />
            ) : (
              <OutcomeChart data={report.data.data} />
            )}
          </section>
        </>
      )}
    </>
  );
}
function Summary({ data }: { readonly data: AnalyticsSummaryResponse }) {
  const duration = (value: number | null) =>
    value === null
      ? 'No data'
      : `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
  const tiles = [
    ['Runs', data.runs.toLocaleString()],
    ['Completed', data.completed.toLocaleString()],
    ['Blocked or awaiting approval', data.blockedOrAwaitingApproval.toLocaleString()],
    ['Failed', data.failed.toLocaleString()],
    ['Total tokens', data.totalTokens.toLocaleString()],
    ['Total cost (USD)', `$${data.totalCostUsd.toFixed(4)}`],
    ['Median run duration', duration(data.medianRunDurationMs)],
    ['Work items done', data.workItemsDone.toLocaleString()],
    ['Median end-to-end duration', duration(data.medianEndToEndDurationMs)],
  ];
  return (
    <div className={styles.tiles}>
      {tiles.map(([label, value]) => (
        <Tile key={label} label={label!} value={value!} />
      ))}
    </div>
  );
}
function formatReportValue(value: number, unit?: string): string {
  return unit === 'USD' ? '$' + value.toFixed(4) : value.toLocaleString();
}

const colors = ['#36a269', '#c58a31', '#687bd3', '#d15b65', '#8b929e'];
function OutcomeChart({ data }: { readonly data: TimeSeriesReport }) {
  if (data.series.some((series) => series.unit !== undefined) && data.series.length > 1)
    return (
      <>
        {data.series.map((series) => (
          <OutcomeChart
            key={series.id}
            data={{
              ...data,
              report: { ...data.report, title: series.title },
              series: [series],
              buckets: data.buckets.map((bucket) => ({
                ...bucket,
                values: { [series.id]: bucket.values[series.id] ?? 0 },
              })),
            }}
          />
        ))}
      </>
    );
  const max = Math.max(
    0,
    ...data.buckets.map((bucket) =>
      Object.values(bucket.values).reduce((sum, count) => sum + count, 0),
    ),
  );
  const scale = max || 1;
  const width = 800,
    height = 200,
    bar = width / Math.max(1, data.buckets.length);
  return (
    <>
      <h2>{data.report.title}</h2>
      <p>
        {data.window.from} to {data.window.to} (UTC)
      </p>
      <div className={reportStyles.legend}>
        {data.series.map(({ id, title }, index) => (
          <span key={id}>
            <i style={{ backgroundColor: colors[index % colors.length] }} />
            {title}: {formatReportValue(data.totals[id] ?? 0, data.series[index]?.unit)}
          </span>
        ))}
      </div>
      <svg
        className={reportStyles.chart}
        viewBox={`0 0 ${width} ${height + 28}`}
        role="img"
        aria-label={data.report.title}
      >
        <text x="0" y="12">
          {formatReportValue(max, data.series[0]?.unit)} {data.series[0]?.unit ?? 'runs'}
        </text>
        {data.buckets.map((bucket, index) => {
          let offset = 0;
          return (
            <g key={bucket.from}>
              <title>
                {bucket.from}:{' '}
                {data.series
                  .map(
                    ({ id, title, unit }) =>
                      `${title} ${formatReportValue(bucket.values[id] ?? 0, unit)}`,
                  )
                  .join(', ')}
              </title>
              {data.series.map(({ id }, seriesIndex) => {
                const h = ((bucket.values[id] ?? 0) / scale) * (height - 20);
                offset += h;
                return (
                  <rect
                    key={id}
                    x={index * bar + 1}
                    y={height - offset}
                    width={Math.max(1, bar - 2)}
                    height={h}
                    fill={colors[seriesIndex % colors.length]}
                  />
                );
              })}
              {index % Math.max(1, Math.ceil(data.buckets.length / 5)) === 0 && (
                <text x={index * bar} y={height + 20}>
                  {new Date(bucket.from).toISOString().slice(5, 16).replace('T', ' ')}
                </text>
              )}
            </g>
          );
        })}
        <line x1="0" y1={height} x2={width} y2={height} stroke="currentColor" />
      </svg>
      <details>
        <summary>Bucket values</summary>
        <div className={reportStyles.table}>
          <table
            aria-label={
              data.series[0]?.unit === undefined
                ? 'Run outcomes by bucket'
                : `${data.report.title} by bucket`
            }
          >
            <thead>
              <tr>
                <th>Bucket start (UTC)</th>
                {data.series.map(({ id, title }) => (
                  <th key={id}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((bucket) => (
                <tr key={bucket.from}>
                  <th>{bucket.from}</th>
                  {data.series.map(({ id, unit }) => (
                    <td key={id}>{formatReportValue(bucket.values[id] ?? 0, unit)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function BreakdownTable({ data }: { readonly data: BreakdownReport }) {
  const [selected, setSelected] = useState<string>();
  const dimension = data.dimensions.find(({ id }) => id === selected) ?? data.dimensions[0];
  return (
    <>
      <h2>{data.report.title}</h2>
      <p>
        {data.window.from} to {data.window.to} (UTC)
      </p>
      <label>
        Dimension{' '}
        <select value={dimension?.id ?? ''} onChange={(event) => setSelected(event.target.value)}>
          {data.dimensions.map(({ id, title }) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
      </label>
      {data.total === 0 ? (
        <EmptyState>No runs in this window</EmptyState>
      ) : (
        <div className={reportStyles.table}>
          <table aria-label="Run breakdowns by dimension">
            <thead>
              <tr>
                <th>{dimension?.title}</th>
                <th>Run count</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {dimension?.rows.map(({ value, count, share }) => (
                <tr key={value}>
                  <th scope="row">{value}</th>
                  <td>{count.toLocaleString()}</td>
                  <td>{(share * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
