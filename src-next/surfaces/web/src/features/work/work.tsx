import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { WorkItemResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { DataTable } from '../../components/data-table.js';
import { CursorPagination, useCursorNavigation } from '../../components/cursor-pagination.js';
import {
  EmptyState,
  ErrorState,
  JsonViewer,
  LoadingState,
  PageHeader,
  Panel,
  StaleIndicator,
  StatusBadge,
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
    render: (item: WorkItemResponse) => (
      <StatusBadge tone={item.state === 'open' ? 'good' : 'neutral'}>{item.state}</StatusBadge>
    ),
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
            <dl>
              <dt>Work identity</dt>
              <dd>{query.data.data.work.workItemId}</dd>
              <dt>State</dt>
              <dd>{query.data.data.work.state}</dd>
              <dt>Workflow</dt>
              <dd>{query.data.data.orchestration.primary?.currentStage ?? 'Not started'}</dd>
              <dt>Resources</dt>
              <dd>{query.data.data.resources.length}</dd>
              <dt>Runs</dt>
              <dd>{query.data.data.execution.runs.length}</dd>
            </dl>
            <JsonViewer value={query.data.data.activities} />
          </Panel>
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
        <button type="button" onClick={() => navigate(-1)}>
          Close
        </button>
        {content}
      </section>
    </div>
  );
}
