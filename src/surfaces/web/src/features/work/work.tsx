import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { AuditEventResponse, BoardCardResponse } from '../../../../api/contracts/index.js';
import { RunResolutionStatusValue } from '../../../../api/contracts/transport-values.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { Chip } from '../../components/chip.js';
import { DataTable } from '../../components/data-table.js';
import { fmtCost, fmtDuration } from '../../components/format.js';
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
import { TokenUsage } from '../../components/token-usage.js';
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
  { label: 'Usage', render: (item: BoardCardResponse) => <TokenUsage usage={item} /> },
];
export function WorkDetail({ modal = false }: { readonly modal?: boolean }) {
  const { workItemKey = '' } = useParams();
  const client = useApiClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: queryKeys.work.all }),
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
  const [resolutionStatus, setResolutionStatus] = useState<
    typeof RunResolutionStatusValue.Failed | typeof RunResolutionStatusValue.Succeeded
  >(RunResolutionStatusValue.Failed);
  const [failureReason, setFailureReason] = useState('Operator determined this run failed.');
  const [successOutcome, setSuccessOutcome] = useState(
    '{\n  "kind": "done",\n  "data": { "status": "DONE" }\n}',
  );
  const resolveAndRetry = useMutation({
    mutationFn: async ({
      runId,
      outcome,
      status,
    }: {
      readonly runId: string;
      readonly outcome?: unknown;
      readonly status:
        typeof RunResolutionStatusValue.Failed | typeof RunResolutionStatusValue.Succeeded;
    }) => {
      const idempotencyKey = globalThis.crypto.randomUUID();
      await client.execution.resolveAmbiguousRun(
        runId,
        status === RunResolutionStatusValue.Failed
          ? { status: RunResolutionStatusValue.Failed, reason: failureReason }
          : { status: RunResolutionStatusValue.Succeeded, outcome },
        `web:resolve-ambiguous-run:${idempotencyKey}`,
      );
      if (status === RunResolutionStatusValue.Succeeded) return;
      return client.work.command(
        workItemKey,
        'retry',
        `web:retry-after-ambiguous-resolution:${globalThis.crypto.randomUUID()}`,
      );
    },
    onSuccess: refresh,
  });
  const [tab, setTab] = useState<'overview' | 'events' | 'transcripts'>('overview');
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [thisRunOnly, setThisRunOnly] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const eventsQuery = useQuery({
    queryKey: queryKeys.events.list('', workItemKey),
    queryFn: ({ signal }) => client.events.list(undefined, workItemKey, signal),
    refetchInterval: refreshPolicy.events,
    enabled: workItemKey !== '',
  });
  const transcriptGroups = [...(query.data?.data.execution.transcriptGroups ?? [])].sort(
    (left, right) =>
      Number(left.kind === 'run') - Number(right.kind === 'run') ||
      right.latestAt.localeCompare(left.latestAt),
  );
  const primaryWorkflow = query.data?.data.orchestration.primary;
  const ambiguousRun = [...(query.data?.data.execution.runs ?? [])]
    .filter(
      (run) =>
        run.workflowInstanceId === primaryWorkflow?.workflowInstanceId &&
        run.status === 'ambiguous',
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const needsAmbiguityResolution =
    primaryWorkflow !== undefined &&
    primaryWorkflow !== null &&
    primaryWorkflow.status === 'blocked' &&
    isAmbiguousRunBlock(primaryWorkflow.blockReason);
  const selectedGroup =
    transcriptGroups.find((group) => group.groupId === selectedGroupId) ?? transcriptGroups[0];
  const transcriptQuery = useQuery({
    queryKey: queryKeys.work.transcript(workItemKey, selectedGroup?.groupId ?? ''),
    queryFn: ({ signal }) => client.work.transcript(workItemKey, selectedGroup!.groupId, signal),
    refetchInterval: refreshPolicy.historicalRuns,
    enabled: tab === 'transcripts' && workItemKey !== '' && selectedGroup !== undefined,
  });
  const selectedRun =
    selectedRunId !== undefined && selectedGroup?.runIds.includes(selectedRunId)
      ? selectedRunId
      : selectedGroup?.runIds.at(-1);
  const transcriptEntries = [...(transcriptQuery.data?.data.entries ?? [])]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .filter((entry) => !thisRunOnly || entry.runId === selectedRun);
  const selectTranscriptGroup = (groupId: string) => {
    const group = transcriptGroups.find((candidate) => candidate.groupId === groupId);
    setSelectedGroupId(groupId);
    setSelectedRunId(group?.runIds.at(-1));
    setThisRunOnly(false);
  };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    const nextIndex =
      event.key === 'ArrowRight'
        ? (currentIndex + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (nextTab === undefined) return;
    const next = nextTab.dataset.tab as typeof tab;
    setTab(next);
    nextTab.focus();
  };
  const content = (
    <div className={styles.detail}>
      {query.isPending ? (
        <LoadingState label="Loading work detail" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          <h2>{query.data.data.work.objective}</h2>
          <div className={styles.tabs} role="tablist" aria-label="Work detail sections">
            <button
              type="button"
              role="tab"
              data-tab="overview"
              id="work-detail-overview-tab"
              aria-controls="work-detail-overview-panel"
              aria-selected={tab === 'overview'}
              tabIndex={tab === 'overview' ? 0 : -1}
              onKeyDown={navigateTabs}
              onClick={() => setTab('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              role="tab"
              data-tab="events"
              id="work-detail-events-tab"
              aria-controls="work-detail-events-panel"
              aria-selected={tab === 'events'}
              tabIndex={tab === 'events' ? 0 : -1}
              onKeyDown={navigateTabs}
              onClick={() => setTab('events')}
            >
              Events
            </button>
            <button
              type="button"
              role="tab"
              data-tab="transcripts"
              id="work-detail-transcripts-tab"
              aria-controls="work-detail-transcripts-panel"
              aria-selected={tab === 'transcripts'}
              tabIndex={tab === 'transcripts' ? 0 : -1}
              onKeyDown={navigateTabs}
              onClick={() => setTab('transcripts')}
            >
              Transcripts
            </button>
          </div>
          {tab === 'transcripts' ? (
            <section
              id="work-detail-transcripts-panel"
              role="tabpanel"
              aria-labelledby="work-detail-transcripts-tab"
            >
              <h2 id="work-transcripts">Transcript conversations</h2>
              {transcriptGroups.length === 0 ? (
                <EmptyState>No transcript conversations</EmptyState>
              ) : (
                <div className={styles.transcriptLayout}>
                  <ol className={styles.transcriptGroups} aria-label="Transcript groups">
                    {transcriptGroups.map((group) => (
                      <li key={group.groupId}>
                        <button
                          type="button"
                          className={styles.transcriptGroup}
                          aria-pressed={selectedGroup?.groupId === group.groupId}
                          onClick={() => selectTranscriptGroup(group.groupId)}
                        >
                          <span>{group.groupId}</span>
                          <span>{group.kind === 'session' ? 'Session' : 'Run fallback'}</span>
                          {group.cli !== undefined && <span>{group.cli}</span>}
                          <LocalTime value={group.latestAt} />
                          <span>{group.runIds.join(', ')}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <div className={styles.transcriptConversation}>
                    {selectedGroup !== undefined && selectedGroup.runIds.length > 1 && (
                      <div className={styles.transcriptFilters}>
                        <label>
                          Run
                          <select
                            value={selectedRun ?? ''}
                            onChange={(event) => setSelectedRunId(event.target.value)}
                          >
                            {selectedGroup.runIds.map((runId) => (
                              <option key={runId} value={runId}>
                                {runId}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={thisRunOnly}
                            onChange={(event) => setThisRunOnly(event.target.checked)}
                          />
                          This run only
                        </label>
                      </div>
                    )}
                    {transcriptQuery.isPending ? (
                      <LoadingState label="Loading transcript" />
                    ) : transcriptQuery.error ? (
                      <ErrorState
                        error={transcriptQuery.error}
                        retry={() => void transcriptQuery.refetch()}
                      />
                    ) : transcriptQuery.data?.data.available === false ? (
                      <EmptyState>Transcript unavailable</EmptyState>
                    ) : transcriptEntries.length === 0 ? (
                      <EmptyState>No transcript messages</EmptyState>
                    ) : (
                      <ol className={styles.transcript} aria-label="Transcript conversation">
                        {transcriptEntries.map((entry, index) => (
                          <li key={`${entry.occurredAt}-${index}`}>
                            {index > 0 && transcriptEntries[index - 1]?.runId !== entry.runId && (
                              <div
                                className={styles.transcriptRunSeparator}
                                role="separator"
                                aria-label={`Run ${entry.runId}`}
                              >
                                Run {entry.runId}
                              </div>
                            )}
                            <article
                              className={
                                entry.channel === 'input'
                                  ? styles.transcriptInput
                                  : styles.transcriptAgent
                              }
                              aria-label={`${entry.channel === 'input' ? 'Input' : 'Agent'} message from ${entry.runId}`}
                            >
                              <div className={styles.transcriptHead}>
                                <span>{entry.channel === 'input' ? 'Input' : 'Agent'}</span>
                                <LocalTime value={entry.occurredAt} />
                                <span>Run {entry.runId}</span>
                                {entry.channel === 'agent' && entry.durationMs !== undefined && (
                                  <span>{fmtDuration(entry.durationMs)}</span>
                                )}
                              </div>
                              <pre
                                className={styles.transcriptText}
                                style={{ whiteSpace: 'pre-wrap' }}
                              >
                                {entry.text}
                              </pre>
                            </article>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              )}
            </section>
          ) : tab === 'events' ? (
            <section
              id="work-detail-events-panel"
              role="tabpanel"
              aria-labelledby="work-detail-events-tab"
            >
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
            <div
              id="work-detail-overview-panel"
              className={styles.overviewLayout}
              role="tabpanel"
              aria-labelledby="work-detail-overview-tab"
            >
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
                    {needsAmbiguityResolution && (
                      <>
                        <dt>Blocked because</dt>
                        <dd>Ambiguous run requires an operator decision</dd>
                      </>
                    )}
                  </dl>
                </Panel>
                {needsAmbiguityResolution && ambiguousRun !== undefined && (
                  <Panel labelledBy="ambiguous-run-resolution">
                    <h2 id="ambiguous-run-resolution" className={styles.sidebarSectionTitle}>
                      Resolve ambiguous run
                    </h2>
                    <p>
                      Decide what happened before retrying this work. Wake will record your
                      decision, then retry the work item.
                    </p>
                    <dl className={styles.summary}>
                      <dt>Run</dt>
                      <dd>{ambiguousRun.runId}</dd>
                      <dt>Token usage</dt>
                      <dd>
                        <TokenUsage usage={ambiguousRun} />
                      </dd>
                      <dt>Cost</dt>
                      <dd>{fmtCost(ambiguousRun.totalCostUsd)}</dd>
                      <dt>Pull request</dt>
                      <dd>
                        {query.data.data.activities.pullRequest === undefined
                          ? 'None recorded'
                          : 'Recorded for this work item'}
                      </dd>
                    </dl>
                    <fieldset disabled={resolveAndRetry.isPending}>
                      <legend>Actual outcome</legend>
                      <label>
                        <input
                          type="radio"
                          name="ambiguous-run-outcome"
                          checked={resolutionStatus === RunResolutionStatusValue.Failed}
                          onChange={() => setResolutionStatus(RunResolutionStatusValue.Failed)}
                        />
                        Failed
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="ambiguous-run-outcome"
                          checked={resolutionStatus === RunResolutionStatusValue.Succeeded}
                          onChange={() => setResolutionStatus(RunResolutionStatusValue.Succeeded)}
                        />
                        Succeeded
                      </label>
                      {resolutionStatus === RunResolutionStatusValue.Failed ? (
                        <label>
                          Reason
                          <textarea
                            value={failureReason}
                            onChange={(event) => setFailureReason(event.target.value)}
                          />
                        </label>
                      ) : (
                        <label>
                          Actual activity outcome (JSON)
                          <textarea
                            value={successOutcome}
                            onChange={(event) => setSuccessOutcome(event.target.value)}
                          />
                        </label>
                      )}
                    </fieldset>
                    <Button
                      type="button"
                      disabled={
                        resolveAndRetry.isPending ||
                        (resolutionStatus === RunResolutionStatusValue.Failed &&
                          failureReason.trim() === '') ||
                        (resolutionStatus === RunResolutionStatusValue.Succeeded &&
                          !isJson(successOutcome))
                      }
                      onClick={() => {
                        try {
                          const outcome =
                            resolutionStatus === RunResolutionStatusValue.Succeeded
                              ? JSON.parse(successOutcome)
                              : undefined;
                          resolveAndRetry.mutate({
                            runId: ambiguousRun.runId,
                            outcome,
                            status: resolutionStatus,
                          });
                        } catch {
                          resolveAndRetry.reset();
                        }
                      }}
                    >
                      {resolutionStatus === RunResolutionStatusValue.Failed
                        ? 'Resolve and retry'
                        : 'Resolve run'}
                    </Button>
                    {resolutionStatus === RunResolutionStatusValue.Succeeded &&
                      !isJson(successOutcome) && (
                        <p role="alert">
                          The actual activity outcome must be valid JSON before resolving the run.
                        </p>
                      )}
                    <MutationFeedback
                      pending={resolveAndRetry.isPending}
                      {...(resolveAndRetry.error === null
                        ? {}
                        : { message: resolveAndRetry.error.message })}
                    />
                  </Panel>
                )}
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

function isAmbiguousRunBlock(reason: string | undefined): boolean {
  return reason !== undefined && /^run-ambiguous-after-\d+-attempts$/.test(reason);
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
