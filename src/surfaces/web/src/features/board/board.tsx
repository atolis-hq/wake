import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/primitives.js';
import styles from '../features.module.css';
import { BoardCard } from './board-card.js';

const collapseStorageKey = 'wake:board:collapsed-columns';
const boardColumns = ['ready', 'active', 'needs-input', 'error', 'finished'] as const;

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
    /* storage is optional */
  }
}
export function Board() {
  const client = useApiClient();
  const location = useLocation();
  const query = useQuery({
    queryKey: queryKeys.board.list(),
    queryFn: ({ signal }) => client.board.list(undefined, signal),
    refetchInterval: refreshPolicy.board,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const toggleColumn = (condition: string) => {
    const next = new Set(collapsed);
    if (next.has(condition)) next.delete(condition);
    else next.add(condition);
    writeCollapsed(next);
    setCollapsed(next);
  };
  if (query.isPending) return <LoadingState label="Loading board" />;
  if (query.error && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const items = query.data?.items ?? [];
  return (
    <>
      {items.length === 0 ? (
        <EmptyState>No work items</EmptyState>
      ) : (
        <div className={styles.board}>
          {boardColumns.map((condition) => {
            const columnItems = items.filter((item) => item.condition === condition);
            return (
              <section className={styles.column} key={condition}>
                <div className={styles.columnHeader}>
                  <h2>{`${label(condition)} (${columnItems.length})`}</h2>
                  <button
                    type="button"
                    className={styles.columnToggle}
                    aria-expanded={!collapsed.has(condition)}
                    aria-label={`${collapsed.has(condition) ? 'Expand' : 'Collapse'} ${label(condition)}`}
                    onClick={() => toggleColumn(condition)}
                  >
                    {collapsed.has(condition) ? '+' : '−'}
                  </button>
                </div>
                {!collapsed.has(condition) && (
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
const label = (value: string) =>
  value
    .split('-')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
