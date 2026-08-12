import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { AuditEventResponse, BoardCardResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { Chip } from '../../components/chip.js';
import { DataTable } from '../../components/data-table.js';
import { fmtCompact, fmtCost } from '../../components/format.js';
import { LocalTime } from '../../components/local-time.js';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  MutationFeedback,
  Panel,
} from '../../components/primitives.js';
import { DocumentIcon, ExternalLinkIcon, GitHubIcon } from '../../components/resource-icons.js';
import { EventRow } from '../events/events.js';
import styles from '../features.module.css';
import { runColumns } from '../runs/runs.js';

const resourceIcons: Record<string, typeof GitHubIcon> = {
  github: GitHubIcon,
};

export function WorkList() {
  const location = useLocation();
  const client = useApiClient();
  const query = useQuery({
    queryKey: queryKeys.board.list(),
    queryFn: ({ signal }) => client.board.list(undefined, signal),
    refetchInterval: refreshPolicy.board,
  });
  const items = query.data?.items ?? [];
  return (
    <>
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
    </>
  );
}

const columns = (location: ReturnType<typeof useLocation>) => [
  { label: 'Ref', render: (item: BoardCardResponse) => item.externalRef ?? '?' },
  {
    label: 'Work item',
    render: (item: BoardCardResponse) => (
      <Link to={`/work/${encodeURIComponent(item.workItemKey)}`} state={{ background: location }}>
        {item.objective}
      </Link>
    ),
  },
  {
    label: 'Condition',
    render: (item: BoardCardResponse) => <Chip variant="outline">{item.condition}</Chip>,
  },
  { label: 'Workflow', render: (item: BoardCardResponse) => item.workflowName ?? '?' },
  { label: 'Stage', render: (item: BoardCardResponse) => item.stage ?? '?' },
  { label: 'Runs', render: (item: BoardCardResponse) => item.runCount },
  {
    label: 'Last run',
    render: (item: BoardCardResponse) =>
      item.lastRunAt === undefined ? '?' : <LocalTime value={item.lastRunAt} />,
  },
  { label: 'Cost', render: (item: BoardCardResponse) => fmtCost(item.totalCostUsd) },
  { label: 'Tokens', render: (item: BoardCardResponse) => fmtCompact(item.totalTokens) },
];
export function WorkDetail({ modal = false }: { readonly modal?: boolean }) {
  const { workItemKey = '' } = useParams();
  const client = useApiClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: queryKeys.work.all }),
      cache.invalidateQueries({ queryKey: queryKeys.work.detail(workItemKey) }),
      cache.invalidateQueries({ queryKey: queryKeys.board.list() }),
    ]);
  };
  const command = useMutation({
    mutationFn: (name: 'freeze' | 'unfreeze' | 'delete' | 'retry') =>
      client.work.command(workItemKey, name, `web:${name}:${globalThis.crypto.randomUUID()}`),
    onSuccess: async (_result, name) => {
      await refresh();
      if (name === 'delete') navigate('/work');
    },
  });
  const query = useQuery({
    queryKey: queryKeys.work.detail(workItemKey),
    queryFn: ({ signal }) => client.work.detail(workItemKey, signal),
    refetchInterval: refreshPolicy.openWork,
    enabled: workItemKey !== '',
  });
  const [tab, setTab] = useState<'overview' | 'events'>('overview');
  const eventsQuery = useQuery({
    queryKey: queryKeys.events.list('', workItemKey),
    queryFn: ({ signal }) => client.events.list(undefined, workItemKey, signal),
    refetchInterval: refreshPolicy.events,
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
          <h2>{query.data.data.work.objective}</h2>
          <nav className={styles.tabs} aria-label="Work detail sections">
            <button
              type="button"
              aria-selected={tab === 'overview'}
              onClick={() => setTab('overview')}
            >
              Overview
            </button>
            <button type="button" aria-selected={tab === 'events'} onClick={() => setTab('events')}>
              Events
            </button>
          </nav>
          {tab === 'events' ? (
            <section aria-labelledby="work-events">
              <h2 id="work-events">Events</h2>
              {eventsQuery.isPending ? (
                <LoadingState label="Loading events" />
              ) : eventsQuery.error ? (
                <ErrorState error={eventsQuery.error} retry={() => void eventsQuery.refetch()} />
              ) : eventsQuery.data?.items.length ? (
                <ol className={styles.eventList}>
                  {[...eventsQuery.data.items]
                    .sort((left, right) => right.position - left.position)
                    .map((event: AuditEventResponse) => (
                      <EventRow record={event} key={event.id} />
                    ))}
                </ol>
              ) : (
                <EmptyState>No events</EmptyState>
              )}
            </section>
          ) : (
            <div className={styles.overviewLayout}>
              <aside className={styles.overviewSidebar}>
                <Panel>
                  <dl className={styles.summary}>
                    <dt>Work identity</dt>
                    <dd>{query.data.data.work.workItemId}</dd>
                    <dt>State</dt>
                    <dd>
                      <Chip variant="outline">{query.data.data.work.state}</Chip>
                    </dd>
                    <dt>Workflow</dt>
                    <dd>{query.data.data.orchestration.primary?.workflowName ?? '?'}</dd>
                    <dt>Stage</dt>
                    <dd>{query.data.data.orchestration.primary?.currentStage ?? 'Not started'}</dd>
                  </dl>
                </Panel>
                <div className={styles.actionBar}>
                  {query.data.data.orchestration.primary?.retryEligible === true && (
                    <Button
                      type="button"
                      disabled={command.isPending}
                      onClick={() => command.mutate('retry')}
                    >
                      Retry
                    </Button>
                  )}
                  <Button
                    type="button"
                    disabled={command.isPending}
                    onClick={() =>
                      command.mutate(query.data.data.work.frozen ? 'unfreeze' : 'freeze')
                    }
                  >
                    {query.data.data.work.frozen ? 'Unfreeze' : 'Freeze'}
                  </Button>
                  <Button
                    type="button"
                    className={styles.dangerButton!}
                    disabled={command.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Delete this work item from the board and remove its resource correlations?',
                        )
                      )
                        command.mutate('delete');
                    }}
                  >
                    Delete
                  </Button>
                  <MutationFeedback
                    pending={command.isPending}
                    {...(command.error === null ? {} : { message: command.error?.message })}
                  />
                </div>

                <section aria-labelledby="work-resources">
                  <h2 id="work-resources" className={styles.sidebarSectionTitle}>
                    Resources
                  </h2>
                  {query.data.data.resources.length === 0 ? (
                    <EmptyState>No correlated resources</EmptyState>
                  ) : (
                    <ul className={styles.resourceList} aria-label="Resources">
                      {query.data.data.resources.map((resource) => {
                        const Icon = resourceIcons[resource.adapter] ?? DocumentIcon;
                        const heading = resource.title ?? resource.locatorLabel;
                        const body = (
                          <>
                            <div className={styles.resourceCardTop}>
                              <Icon className={styles.resourceCardIcon} />
                              <span className={styles.resourceCardTitle}>{heading}</span>
                              {resource.externalUrl !== undefined && (
                                <ExternalLinkIcon className={styles.resourceCardExt} />
                              )}
                            </div>
                            <div className={styles.resourceCardMeta}>
                              {resource.title !== undefined && (
                                <span className={styles.resourceId}>{resource.locatorLabel}</span>
                              )}
                              {resource.capabilities.map((capability) => (
                                <Chip key={capability} variant="outline">
                                  {capability}
                                </Chip>
                              ))}
                            </div>
                          </>
                        );
                        return (
                          <li key={resource.resourceId}>
                            {resource.externalUrl !== undefined ? (
                              <a
                                className={styles.resourceCard}
                                href={resource.externalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {body}
                              </a>
                            ) : (
                              <div className={styles.resourceCard}>{body}</div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </aside>

              <section className={styles.overviewMain} aria-labelledby="work-runs">
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
            </div>
          )}
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
          {query.data?.data.work.externalRef !== undefined && (
            <span className={styles.modalRef}>{query.data.data.work.externalRef}</span>
          )}
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
