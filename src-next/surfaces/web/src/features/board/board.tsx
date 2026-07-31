import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import type { WorkItemResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StaleIndicator,
} from '../../components/primitives.js';
import styles from '../features.module.css';

export function Board() {
  const client = useApiClient();
  const location = useLocation();
  const query = useQuery({
    queryKey: queryKeys.work.list(),
    queryFn: ({ signal }) => client.work.list({}, signal),
    refetchInterval: refreshPolicy.board,
  });
  if (query.isPending)
    return (
      <>
        <PageHeader title="Board" />
        <LoadingState label="Loading board" />
      </>
    );
  if (query.error && !query.data)
    return (
      <>
        <PageHeader title="Board" />
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </>
    );
  const items = query.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Board"
        actions={<StaleIndicator refreshing={query.isFetching} stale={query.isStale} />}
      />
      {items.length === 0 ? (
        <EmptyState>No work items</EmptyState>
      ) : (
        <div className={styles.board}>
          {(['open', 'closed', 'cancelled'] as const).map((state) => (
            <section className={styles.column} key={state}>
              <h2>{label(state)}</h2>
              <ul className={styles.cards}>
                {items
                  .filter((item) => item.state === state)
                  .map((item) => (
                    <WorkCard key={item.workItemKey} item={item} background={location} />
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function WorkCard({
  item,
  background,
}: {
  readonly item: WorkItemResponse;
  readonly background: ReturnType<typeof useLocation>;
}) {
  return (
    <li className={styles.card}>
      <Link to={`/work/${encodeURIComponent(item.workItemKey)}`} state={{ background }}>
        {item.objective}
      </Link>
      <div>
        {item.workItemId} · {item.state}
      </div>
    </li>
  );
}
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1);
