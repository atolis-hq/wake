import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { RunResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshInterval, refreshPolicy } from '../../api/refresh-policy.js';
import { CursorPagination, useCursorNavigation } from '../../components/cursor-pagination.js';
import { DataTable } from '../../components/data-table.js';
import { fmtCost, fmtDuration } from '../../components/format.js';
import { LocalTime } from '../../components/local-time.js';
import {
  EmptyState,
  ErrorState,
  JsonViewer,
  LoadingState,
  Panel,
  StatusBadge,
} from '../../components/primitives.js';
import { TokenUsage } from '../../components/token-usage.js';
import styles from '../features.module.css';

export function RunsList() {
  const client = useApiClient();
  const navigation = useCursorNavigation();
  const query = useQuery({
    queryKey: queryKeys.execution.runList(navigation.cursor),
    queryFn: ({ signal }) => client.execution.runs(navigation.cursor, signal),
    refetchInterval: (state) => refreshInterval.runs(state.state.data?.items),
  });
  return (
    <>
      {query.isPending ? (
        <LoadingState label="Loading runs" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <EmptyState>No runs</EmptyState>
      ) : (
        <DataTable
          caption="Execution runs"
          rows={query.data!.items}
          rowKey={(run) => run.runId}
          columns={runColumns}
        />
      )}
      {query.data && (
        <CursorPagination
          navigation={navigation}
          nextCursor={query.data.page.nextCursor}
          hasMore={query.data.page.hasMore}
        />
      )}
    </>
  );
}
export const runColumns = [
  {
    label: 'Run',
    render: (run: RunResponse) => (
      <Link to={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</Link>
    ),
  },
  { label: 'Activity', render: (run: RunResponse) => run.activity },
  { label: 'Workflow', render: (run: RunResponse) => run.workflowName ?? '?' },
  { label: 'Stage', render: (run: RunResponse) => run.stage ?? '?' },
  { label: 'Runner', render: (run: RunResponse) => runnerLabel(run) },
  { label: 'Status', render: (run: RunResponse) => runStatusLabel(run) },
  { label: 'Started', render: (run: RunResponse) => <LocalTime value={run.startedAt} /> },
  { label: 'Duration', render: (run: RunResponse) => runDuration(run) },
  { label: 'Usage', render: (run: RunResponse) => <TokenUsage usage={run} /> },
  { label: 'Cost', render: (run: RunResponse) => fmtCost(run.totalCostUsd) },
];
function runnerLabel(run: RunResponse): string {
  if (run.runnerName === undefined) return '?';
  return run.runnerModel === undefined ? run.runnerName : `${run.runnerName} (${run.runnerModel})`;
}
function runDuration(run: RunResponse): string {
  const end = run.active
    ? Date.now()
    : run.finishedAt === undefined
      ? undefined
      : Date.parse(run.finishedAt);
  return end === undefined ? '' : fmtDuration(end - Date.parse(run.startedAt));
}
function runStatusLabel(run: RunResponse): string {
  if (run.status === 'starting') return 'Starting';
  if (run.status === 'started') return 'Running';
  return run.resolution?.sentinel ?? run.sentinel;
}
export function RunDetail() {
  const { runId = '' } = useParams();
  const client = useApiClient();
  const run = useQuery({
    queryKey: queryKeys.execution.run(runId),
    queryFn: ({ signal }) => client.execution.run(runId, signal),
    refetchInterval: (state) =>
      refreshInterval.runs(state.state.data === undefined ? undefined : [state.state.data.data]),
  });
  const transcript = useQuery({
    queryKey: queryKeys.execution.transcript(runId),
    queryFn: ({ signal }) => client.execution.transcript(runId, signal),
    refetchInterval: refreshPolicy.historicalRuns,
    enabled: runId !== '',
  });
  return (
    <>
      <h2>{`Run ${runId}`}</h2>
      {run.isPending ? (
        <LoadingState label="Loading run" />
      ) : run.error ? (
        <ErrorState error={run.error} retry={() => void run.refetch()} />
      ) : (
        run.data && (
          <Panel>
            <StatusBadge>{runStatusLabel(run.data.data)}</StatusBadge>
            <dl className={styles.summary}>
              <dt>Activity</dt>
              <dd>{run.data.data.activity}</dd>
              <dt>Attempt</dt>
              <dd>{run.data.data.attempt}</dd>
              <dt>Started</dt>
              <dd>
                <LocalTime value={run.data.data.startedAt} />
              </dd>
              {run.data.data.finishedAt !== undefined && (
                <>
                  <dt>Finished</dt>
                  <dd>
                    <LocalTime value={run.data.data.finishedAt} />
                  </dd>
                </>
              )}
            </dl>
            {(run.data.data.outcome ?? run.data.data.failure) !== undefined && (
              <JsonViewer value={run.data.data.outcome ?? run.data.data.failure} />
            )}
            <h2>Transcript</h2>
            {transcript.data?.data.available ? (
              <ol className={styles.transcript} aria-label="Transcript">
                {transcript.data.data.entries.map((entry, index) => (
                  <li className={styles.transcriptEntry} key={`${entry.occurredAt}-${index}`}>
                    <div className={styles.transcriptHead}>
                      <span>{entry.channel}</span>
                      <LocalTime value={entry.occurredAt} />
                    </div>
                    <pre className={styles.transcriptText}>{entry.text}</pre>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState>Transcript unavailable</EmptyState>
            )}
          </Panel>
        )
      )}
    </>
  );
}
