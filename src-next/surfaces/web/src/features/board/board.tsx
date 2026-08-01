import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { BoardCard } from './board-card.js';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StaleIndicator,
} from '../../components/primitives.js';
import styles from '../features.module.css';

const collapseStorageKey = 'wake:board:collapsed-columns';

function readCollapsed(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(collapseStorageKey);
    if (raw === null || raw === undefined) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(collapseStorageKey, JSON.stringify([...collapsed]));
  } catch {
    // Storage failures must not break the toggle for this render.
  }
}

export function Board() {
  const client = useApiClient();
  const location = useLocation();
  const query = useQuery({
    queryKey: queryKeys.work.list(),
    queryFn: ({ signal }) => client.work.list({}, signal),
    refetchInterval: refreshPolicy.board,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const toggleColumn = (state: string) => {
    const next = new Set(collapsed);
    if (next.has(state)) next.delete(state);
    else next.add(state);
    writeCollapsed(next);
    setCollapsed(next);
  };
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
          {boardColumns.map((state) => {
            const columnItems = items.filter((item) => item.state === state);
            return (
              <section className={styles.column} key={state}>
                <div className={styles.columnHeader}>
                  <h2>{`${label(state)} (${columnItems.length})`}</h2>
                  <button
                    type="button"
                    className={styles.columnToggle}
                    aria-expanded={!collapsed.has(state)}
                    aria-label={`${collapsed.has(state) ? 'Expand' : 'Collapse'} ${label(state)}`}
                    onClick={() => toggleColumn(state)}
                  >
                    {collapsed.has(state) ? '+' : '−'}
                  </button>
                </div>
                {!collapsed.has(state) && (
                  <ul className={styles.cards}>
                    {columnItems.map((item) => (
                      <BoardCard key={item.workItemKey} item={item} background={location} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

const boardColumns = ['open', 'closed', 'cancelled'] as const;
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1);
