import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import type { BoardCardResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/primitives.js';
import styles from '../features.module.css';
import { BoardCard } from './board-card.js';

const collapseStorageKey = 'wake:board:collapsed-columns';
const groupByStorageKey = 'wake:board:group-by';
const swimlaneCollapseStorageKey = 'wake:board:collapsed-swimlanes';
const boardColumns = ['ready', 'active', 'needs-input', 'error', 'finished'] as const;
const groupByOptions = ['none', 'workflowName', 'stage'] as const;
type GroupBy = (typeof groupByOptions)[number];

function swimlaneStorageId(groupBy: Exclude<GroupBy, 'none'>, laneKey: string): string {
  return JSON.stringify([groupBy, laneKey]);
}
function readGroupBy(): GroupBy {
  try {
    const raw = globalThis.localStorage?.getItem(groupByStorageKey);
    return raw !== null && raw !== undefined && (groupByOptions as readonly string[]).includes(raw)
      ? (raw as GroupBy)
      : 'none';
  } catch {
    return 'none';
  }
}
function writeGroupBy(groupBy: GroupBy): void {
  try {
    globalThis.localStorage?.setItem(groupByStorageKey, groupBy);
  } catch {
    /* storage is optional */
  }
}

const ungroupedLabel: Record<Exclude<GroupBy, 'none'>, string> = {
  workflowName: 'No workflow',
  stage: 'No stage',
};

interface Swimlane {
  readonly key: string;
  readonly label: string | undefined;
  readonly items: readonly BoardCardResponse[];
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.(query);
    if (media === undefined) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function groupItems(items: readonly BoardCardResponse[], groupBy: GroupBy): readonly Swimlane[] {
  if (groupBy === 'none') return [{ key: 'all', label: undefined, items }];
  const buckets = new Map<string, BoardCardResponse[]>();
  for (const item of items) {
    const value = groupBy === 'workflowName' ? item.workflowName : item.stage;
    const key = value === undefined || value === '' ? ungroupedLabel[groupBy] : value;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, laneItems]) => ({ key, label: key, items: laneItems }));
}

export function Board() {
  const client = useApiClient();
  const location = useLocation();
  const query = useQuery({
    queryKey: queryKeys.board.list(),
    queryFn: ({ signal }) => client.board.list(undefined, signal),
    refetchInterval: refreshPolicy.board,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    readCollapsedFromStorage(collapseStorageKey),
  );
  const [collapsedSwimlanes, setCollapsedSwimlanes] = useState<ReadonlySet<string>>(() =>
    readCollapsedFromStorage(swimlaneCollapseStorageKey),
  );
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
  const mobile = useMediaQuery('(max-width: 42rem)');
  const toggleColumn = (condition: string) => {
    const next = new Set(collapsed);
    if (next.has(condition)) next.delete(condition);
    else next.add(condition);
    writeCollapsedToStorage(collapseStorageKey, next);
    setCollapsed(next);
  };
  const changeGroupBy = (next: GroupBy) => {
    writeGroupBy(next);
    setGroupBy(next);
  };
  const toggleSwimlane = (lane: Swimlane) => {
    if (groupBy === 'none') return;
    const id = swimlaneStorageId(groupBy, lane.key);
    const next = new Set(collapsedSwimlanes);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeCollapsedToStorage(swimlaneCollapseStorageKey, next);
    setCollapsedSwimlanes(next);
  };
  if (query.isPending) return <LoadingState label="Loading board" />;
  if (query.error && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const items = query.data?.items ?? [];
  const swimlanes = groupItems(items, groupBy);
  return (
    <>
      <div className={styles.boardControls}>
        <label>
          Group by
          <select
            value={groupBy}
            onChange={(event) => changeGroupBy(event.target.value as GroupBy)}
          >
            <option value="none">None</option>
            <option value="workflowName">Workflow</option>
            <option value="stage">Stage</option>
          </select>
        </label>
      </div>
      {items.length === 0 ? (
        <EmptyState>No work items</EmptyState>
      ) : (
        <div className={styles.swimlanes}>
          {swimlanes.map((lane) => {
            const swimlaneId =
              lane.label === undefined
                ? undefined
                : swimlaneStorageId(groupBy as Exclude<GroupBy, 'none'>, lane.key);
            const laneCollapsed = swimlaneId !== undefined && collapsedSwimlanes.has(swimlaneId);
            const laneLabel = `${lane.label} (${lane.items.length})`;
            return (
              <section key={lane.key}>
                {lane.label !== undefined && (
                  <h2 className={styles.swimlaneHeader}>
                    <button
                      type="button"
                      className={styles.swimlaneToggle}
                      aria-expanded={!laneCollapsed}
                      onClick={() => toggleSwimlane(lane)}
                    >
                      <span>{laneLabel}</span>
                      <span aria-hidden="true">{laneCollapsed ? '▸' : '▾'}</span>
                    </button>
                  </h2>
                )}
                {!laneCollapsed && (
                  <div className={styles.board}>
                    {boardColumns.map((condition) => {
                      const columnItems = lane.items.filter((item) => item.condition === condition);
                      const canCollapse = mobile || condition === 'finished';
                      const isCollapsed = canCollapse && collapsed.has(condition);
                      const columnLabel =
                        lane.label === undefined
                          ? label(condition)
                          : `${label(condition)} · ${lane.label}`;
                      return (
                        <section className={styles.column} key={`${lane.key}-${condition}`}>
                          <div className={styles.columnHeader}>
                            <h2>{`${label(condition)} (${columnItems.length})`}</h2>
                            {canCollapse && (
                              <button
                                type="button"
                                className={`${styles.columnToggle} ${condition === 'finished' ? styles.finishedColumnToggle : ''}`}
                                aria-expanded={!isCollapsed}
                                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${columnLabel}`}
                                onClick={() => toggleColumn(condition)}
                              >
                                {isCollapsed ? '+' : '−'}
                              </button>
                            )}
                          </div>
                          {!isCollapsed && (
                            <ul className={styles.cards}>
                              {columnItems.map((item) => (
                                <BoardCard
                                  key={item.workItemKey}
                                  item={item}
                                  background={location}
                                />
                              ))}
                            </ul>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function readCollapsedFromStorage(key: string): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedToStorage(key: string, collapsed: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify([...collapsed]));
  } catch {
    /* storage is optional */
  }
}
const label = (value: string) =>
  value
    .split('-')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
