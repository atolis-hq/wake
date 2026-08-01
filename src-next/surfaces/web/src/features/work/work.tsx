import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { RunResponse, WorkItemResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { DataTable } from '../../components/data-table.js';
import { LocalTime } from '../../components/local-time.js';
import { CursorPagination, useCursorNavigation } from '../../components/cursor-pagination.js';
import { Chip } from '../../components/chip.js';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  StaleIndicator,
} from '../../components/primitives.js';
import styles from '../features.module.css';

export function WorkList() {
  const navigation = useCursorNavigation();
  const location = useLocation();
  const parameters = new URLSearchParams(location.search);
  const search = parameters.get('search') ?? '';
  const state = parameters.get('state') ?? '';
  const client = useApiClient();
  const query = useQuery({
    queryKey: queryKeys.work.list(search, state, navigation.cursor),
    queryFn: ({ signal }) =>
      client.work.list(
        {
          ...(navigation.cursor === undefined ? {} : { cursor: navigation.cursor }),
          ...(search === '' ? {} : { search }),
          ...(state === '' ? {} : { state }),
        },
        signal,
      ),
    refetchInterval: refreshPolicy.board,
  });
  const items = query.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Work"
        actions={<StaleIndicator refreshing={query.isFetching} stale={query.isStale} />}
      />
      <form className={styles.filters} role="search" onSubmit={(event) => event.preventDefault()}>
        <label>
          Search
          <input
            value={search}
            onChange={(event) => navigation.setFilter('search', event.target.value)}
          />
        </label>
        <label>
          State
          <select
            value={state}
            onChange={(event) => navigation.setFilter('state', event.target.value)}
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </form>
      {query.isPending ? (
        <LoadingState label="Loading work" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState>No matching work items</EmptyState>
      ) : (
        <DataTable
          caption="Work items"
          rows={items}
          rowKey={(item) => item.workItemKey}
          columns={columns(location)}
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

const columns = (location: ReturnType<typeof useLocation>) => [
  {
    label: 'Work item',
    render: (item: WorkItemResponse) => (
      <Link to={`/work/${encodeURIComponent(item.workItemKey)}`} state={{ background: location }}>
        {item.objective}
      </Link>
    ),
  },
  { label: 'Identity', render: (item: WorkItemResponse) => item.workItemId },
  {
    label: 'State',
    render: (item: WorkItemResponse) => <Chip variant="outline">{item.state}</Chip>,
  },
];

export function WorkDetail({ modal = false }: { readonly modal?: boolean }) {
  const { workItemKey = '' } = useParams();
  const client = useApiClient();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: queryKeys.work.detail(workItemKey),
    queryFn: ({ signal }) => client.work.detail(workItemKey, signal),
    refetchInterval: refreshPolicy.openWork,
    enabled: workItemKey !== '',
  });
  const content = (
    <div className={styles.detail}>
      {query.isPending ? (
        <LoadingState label="Loading work detail" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          <PageHeader
            title={query.data.data.work.objective}
            actions={<StaleIndicator refreshing={query.isFetching} stale={query.isStale} />}
          />
          <Panel>
            <dl className={styles.summary}>
              <dt>Work identity</dt>
              <dd>{query.data.data.work.workItemId}</dd>
              <dt>State</dt>
              <dd>
                <Chip variant="outline">{query.data.data.work.state}</Chip>
              </dd>
              <dt>Stage</dt>
              <dd>{query.data.data.orchestration.primary?.currentStage ?? 'Not started'}</dd>
              <dt>Workflow</dt>
              <dd>{query.data.data.orchestration.primary?.workflowName ?? '—'}</dd>
            </dl>
          </Panel>

          <section aria-labelledby="work-resources">
            <h2 id="work-resources">Resources</h2>
            {query.data.data.resources.length === 0 ? (
              <EmptyState>No correlated resources</EmptyState>
            ) : (
              <ul className={styles.resourceList} aria-label="Resources">
                {query.data.data.resources.map((resource) => (
                  <li key={resource.resourceId}>
                    <Chip>{resource.kind}</Chip>
                    <span className={styles.resourceId}>{resource.resourceId}</span>
                    {resource.capabilities.map((capability) => (
                      <Chip key={capability} variant="outline">
                        {capability}
                      </Chip>
                    ))}
                    {resource.revision !== undefined && (
                      <span className={styles.resourceId}>{resource.revision}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="work-runs">
            <h2 id="work-runs">Runs</h2>
            {query.data.data.execution.runs.length === 0 ? (
              <EmptyState>No runs</EmptyState>
            ) : (
              <DataTable
                caption="Runs"
                rows={query.data.data.execution.runs}
                rowKey={(run) => run.runId}
                columns={runColumns}
              />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
  if (!modal) return content;
  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) navigate(-1);
      }}
    >
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Work item detail"
      >
        <div className={styles.modalHeader}>
          <button
            className={styles.modalClose!}
            type="button"
            aria-label="Close work detail"
            onClick={() => navigate(-1)}
          >
            Close
          </button>
        </div>
        {content}
      </section>
    </div>
  );
}

const runColumns = [
  {
    label: 'Run',
    render: (run: RunResponse) => (
      <Link to={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</Link>
    ),
  },
  { label: 'Activity', render: (run: RunResponse) => run.activity },
  { label: 'Status', render: (run: RunResponse) => <Chip variant="outline">{run.status}</Chip> },
  { label: 'Started', render: (run: RunResponse) => <LocalTime value={run.startedAt} /> },
];
