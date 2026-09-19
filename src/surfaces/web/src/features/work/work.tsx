import { faHourglassHalf, faPaperPlane } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  AuditEventResponse,
  BoardCardResponse,
  RunResponse,
} from '../../../../api/contracts/index.js';
import {
  ActivityOutcomeKindValue,
  RunResolutionStatusValue,
} from '../../../../api/contracts/transport-values.js';
import { useApiClient } from '../../api/context.js';
import { queryKeys } from '../../api/query-keys.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { Chip } from '../../components/chip.js';
import { DataTable } from '../../components/data-table.js';
import { fmtCost, fmtDuration } from '../../components/format.js';
import { LocalTime } from '../../components/local-time.js';
import { OutcomeChip } from '../../components/outcome-chip.js';
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
import { WorkflowDiagramView } from '../workflow-diagram/workflow-diagram.js';

const resourceIcons: Record<string, typeof GitHubIcon> = {
  github: GitHubIcon,
};

export function WorkList() {
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
          columns={columns}
        />
      )}
    </>
  );
}

const columns = [
  { label: 'Ref', render: (item: BoardCardResponse) => item.externalRef ?? '?' },
  {
    label: 'Work item',
    render: (item: BoardCardResponse) => (
      <Link to={`/work/${encodeURIComponent(item.workItemKey)}`}>{item.objective}</Link>
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
  {
    label: 'Outcome',
    render: (item: BoardCardResponse) =>
      item.lastRunOutcome === undefined ? '?' : <OutcomeChip outcome={item.lastRunOutcome} />,
  },
  { label: 'Cost', render: (item: BoardCardResponse) => fmtCost(item.totalCostUsd) },
  { label: 'Usage', render: (item: BoardCardResponse) => <TokenUsage usage={item} /> },
];
export function WorkDetail() {
  const { workItemKey = '' } = useParams();
  return <WorkDetailContent key={workItemKey} workItemKey={workItemKey} />;
}

function WorkDetailContent({ workItemKey }: { readonly workItemKey: string }) {
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
    mutationFn: (name: 'freeze' | 'unfreeze' | 'delete' | 'retry' | 'extend') =>
      client.work.command(workItemKey, name, `web:${name}:${globalThis.crypto.randomUUID()}`),
    onSuccess: async (_result, name) => {
      await refresh();
      if (name === 'delete') navigate('/work');
    },
  });
  const [messageBody, setMessageBody] = useState('');
  const [awaitingAgentReply, setAwaitingAgentReply] = useState(false);
  const agentReplyCountAtSend = useRef(0);
  const messageTextarea = useRef<HTMLTextAreaElement>(null);
  const message = useMutation({
    mutationFn: (body: string) =>
      client.work.message(
        workItemKey,
        body,
        `web:conversation-message:${globalThis.crypto.randomUUID()}`,
      ),
    onSuccess: async () => {
      agentReplyCountAtSend.current = conversationEntries.filter(
        (entry) => entry.origin === 'agent',
      ).length;
      setAwaitingAgentReply(true);
      followLatest.current = true;
      setReadingHistory(false);
      setMessageBody('');
      if (messageTextarea.current) messageTextarea.current.style.height = '';
      await refresh();
    },
  });
  const sendMessage = () => {
    const body = messageBody.trim();
    if (body !== '' && !message.isPending) message.mutate(body);
  };
  const query = useQuery({
    queryKey: queryKeys.work.detail(workItemKey),
    queryFn: ({ signal }) => client.work.detail(workItemKey, signal),
    refetchInterval: refreshPolicy.openWork,
    enabled: workItemKey !== '',
  });
  const diagramQuery = useQuery({
    queryKey: queryKeys.workflowDiagrams.get(workItemKey),
    queryFn: ({ signal }) => client.workflowDiagrams.get(workItemKey, signal),
    refetchInterval: refreshPolicy.workflowDiagrams,
    enabled: workItemKey !== '' && query.data?.data.orchestration.primary !== null,
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
  const [tab, setTab] = useState<
    'overview' | 'runs' | 'conversation' | 'events' | 'transcripts' | 'artifacts'
  >('overview');
  const conversationViewport = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [readingHistory, setReadingHistory] = useState(false);
  const conversationEntries = [...(query.data?.data.conversation.entries ?? [])].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt),
  );
  const latestMessage = conversationEntries.at(-1);
  const activeRun = query.data?.data.execution.runs.find((run) => run.active);
  useEffect(() => {
    const agentReplies = conversationEntries.filter((entry) => entry.origin === 'agent').length;
    if (awaitingAgentReply && agentReplies > agentReplyCountAtSend.current)
      setAwaitingAgentReply(false);
  }, [awaitingAgentReply, conversationEntries]);
  useLayoutEffect(() => {
    followLatest.current = true;
    setReadingHistory(false);
  }, [tab]);
  useLayoutEffect(() => {
    if (tab === 'conversation' && followLatest.current && conversationViewport.current) {
      conversationViewport.current.scrollTop = conversationViewport.current.scrollHeight;
    }
  }, [tab, latestMessage?.entryId, latestMessage?.body]);
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
    <div className={`${styles.detail} ${tab === 'conversation' ? styles.detailChat : ''}`}>
      {query.isPending ? (
        <LoadingState label="Loading work detail" />
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Work detail sections">
            {(
              ['overview', 'runs', 'artifacts', 'events', 'transcripts', 'conversation'] as const
            ).map((section) => (
              <button
                key={section}
                type="button"
                role="tab"
                data-tab={section}
                id={`work-detail-${section}-tab`}
                aria-controls={`work-detail-${section}-panel`}
                aria-selected={tab === section}
                tabIndex={tab === section ? 0 : -1}
                onKeyDown={navigateTabs}
                onClick={() => setTab(section)}
              >
                {section === 'overview' ? 'Overview' : section[0]!.toUpperCase() + section.slice(1)}
              </button>
            ))}
          </div>
          <h1 className={styles.workTitle}>
            {query.data.data.work.externalRef && <span>{query.data.data.work.externalRef}</span>}
            {query.data.data.work.objective}
          </h1>
          {tab !== 'conversation' && tab !== 'transcripts' && (
            <div className={styles.workSummary}>
              <Panel>
                <dl className={styles.summary}>
                  <div>
                    <dt>Work identity</dt>
                    <dd>{query.data.data.work.workItemId}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>
                      <Chip variant="outline">{query.data.data.work.state}</Chip>
                    </dd>
                  </div>
                  <div>
                    <dt>Workflow</dt>
                    <dd>{query.data.data.orchestration.primary?.workflowName ?? '?'}</dd>
                  </div>
                  <div>
                    <dt>Stage</dt>
                    <dd>{query.data.data.orchestration.primary?.currentStage ?? 'Not started'}</dd>
                  </div>
                  {needsAmbiguityResolution && (
                    <>
                      <div>
                        <dt>Blocked because</dt>
                        <dd>Ambiguous run requires an operator decision</dd>
                      </div>
                    </>
                  )}
                  {query.data.data.work.lastRunOutcome !== undefined && (
                    <>
                      <div>
                        <dt>Last run</dt>
                        <dd>
                          <OutcomeChip
                            outcome={query.data.data.work.lastRunOutcome}
                            title="Outcome of the most recent run"
                          />
                        </dd>
                      </div>
                    </>
                  )}
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
                {query.data.data.orchestration.primary?.extendEligible === true && (
                  <Button
                    type="button"
                    disabled={command.isPending}
                    onClick={() => command.mutate('extend')}
                  >
                    Extend
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
            </div>
          )}
          {tab === 'runs' ? (
            <section
              id="work-detail-runs-panel"
              role="tabpanel"
              aria-labelledby="work-detail-runs-tab"
            >
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
          ) : tab === 'artifacts' ? (
            <section
              id="work-detail-artifacts-panel"
              role="tabpanel"
              aria-labelledby="work-detail-artifacts-tab"
            >
              {query.data.data.artifacts.length === 0 ? (
                <EmptyState>No published artifacts</EmptyState>
              ) : (
                <DataTable
                  caption="Published artifacts"
                  rows={query.data.data.artifacts}
                  rowKey={(artifact) => artifact.revisionId}
                  columns={[
                    { label: 'Producer', render: (artifact) => artifact.producer },
                    { label: 'Path', render: (artifact) => artifact.path },
                    { label: 'Type', render: (artifact) => artifact.mediaType ?? 'binary' },
                    {
                      label: 'Bytes',
                      render: (artifact) => artifact.byteLength?.toLocaleString() ?? '?',
                    },
                  ]}
                />
              )}
            </section>
          ) : tab === 'conversation' ? (
            <section
              id="work-detail-conversation-panel"
              className={styles.conversationPanel}
              role="tabpanel"
              aria-labelledby="work-detail-conversation-tab"
            >
              <div
                ref={conversationViewport}
                className={styles.conversationViewport}
                role="region"
                aria-label="Message history"
                tabIndex={0}
                onScroll={(event) => {
                  const viewport = event.currentTarget;
                  followLatest.current =
                    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64;
                  setReadingHistory(!followLatest.current);
                }}
              >
                {conversationEntries.length === 0 ? (
                  <EmptyState>No conversation messages</EmptyState>
                ) : (
                  <ol className={styles.conversationTimeline} aria-label="Conversation">
                    {conversationEntries.map((entry) => {
                      const source = query.data.data.resources.find(
                        (resource) => resource.resourceId === entry.sourceResourceId,
                      );
                      return (
                        <li key={entry.entryId}>
                          <article className={styles.conversationEntry} data-origin={entry.origin}>
                            <ConversationAvatar
                              actorId={entry.actorId}
                              sourceAdapter={entry.sourceAdapter}
                            />
                            <header className={styles.conversationEntryHead}>
                              <strong>{entry.actorId}</strong>
                              <span className={styles.conversationSource}>
                                via {entry.sourceAdapter ?? entry.origin}
                              </span>
                              <LocalTime value={entry.occurredAt} />
                              {entry.runId !== undefined && (
                                <span>
                                  <Link to={`/runs/${encodeURIComponent(entry.runId)}`}>
                                    run {entry.runId}
                                  </Link>
                                  {entry.stage === undefined ? '' : ` (${entry.stage})`}
                                </span>
                              )}
                              {source !== undefined && (
                                <span>
                                  {source.externalUrl === undefined ? (
                                    source.locatorLabel
                                  ) : (
                                    <a
                                      href={source.externalUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      {source.locatorLabel}
                                    </a>
                                  )}
                                </span>
                              )}
                            </header>
                            {entry.deleted ? (
                              <em>Message deleted</em>
                            ) : (
                              <div className={styles.conversationBody}>{entry.body}</div>
                            )}
                            {entry.representations.length > 0 && (
                              <footer className={styles.conversationRepresentations}>
                                {entry.representations.map((representation) => {
                                  const resource = query.data.data.resources.find(
                                    (candidate) =>
                                      candidate.resourceId === representation.resourceId,
                                  );
                                  const label = resource?.locatorLabel ?? representation.resourceId;
                                  return (
                                    <span
                                      key={`${representation.resourceId}:${representation.externalId}`}
                                    >
                                      Published to{' '}
                                      {resource?.externalUrl === undefined ? (
                                        label
                                      ) : (
                                        <a
                                          href={resource.externalUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                        >
                                          {label}
                                        </a>
                                      )}
                                    </span>
                                  );
                                })}
                              </footer>
                            )}
                          </article>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
              <div className={styles.conversationFooter}>
                {awaitingAgentReply && (
                  <div className={styles.conversationProgress} role="status" aria-live="polite">
                    {activeRun === undefined ? (
                      <FontAwesomeIcon
                        icon={faHourglassHalf}
                        className={styles.conversationWaitingIcon}
                        aria-hidden="true"
                      />
                    ) : (
                      <span className={styles.conversationProgressDot} data-active-run="true" />
                    )}
                    <span className={styles.conversationProgressTitle}>
                      {activeRun === undefined ? 'Queued for Wake' : activeRun.activity}
                    </span>
                    {activeRun !== undefined && (
                      <span className={styles.conversationProgressMeta}>
                        {activeRun.stage !== undefined && `Stage: ${activeRun.stage}`}
                        {activeRun.stage !== undefined &&
                          (activeRun.runnerName !== undefined ||
                            activeRun.runnerModel !== undefined) &&
                          ' · '}
                        {(activeRun.runnerName !== undefined ||
                          activeRun.runnerModel !== undefined) &&
                          `Runner: ${activeRun.runnerName ?? activeRun.runnerModel}`}
                      </span>
                    )}
                  </div>
                )}
                {readingHistory && (
                  <Button
                    className={styles.conversationLatest}
                    onClick={() => {
                      followLatest.current = true;
                      setReadingHistory(false);
                      if (conversationViewport.current)
                        conversationViewport.current.scrollTop =
                          conversationViewport.current.scrollHeight;
                    }}
                  >
                    Jump to latest
                  </Button>
                )}
                {query.data.data.conversation.canCreateEntries && (
                  <form
                    className={styles.conversationComposer}
                    onSubmit={(event) => {
                      event.preventDefault();
                      sendMessage();
                    }}
                  >
                    <textarea
                      ref={messageTextarea}
                      id="work-conversation-message"
                      aria-label="Message"
                      value={messageBody}
                      disabled={message.isPending}
                      onChange={(event) => {
                        setMessageBody(event.target.value);
                        event.currentTarget.style.height = 'auto';
                        event.currentTarget.style.height = `${Math.min(
                          event.currentTarget.scrollHeight,
                          192,
                        )}px`;
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          sendMessage();
                        }
                      }}
                      placeholder="Add context, answer a question, or direct the current work."
                      rows={1}
                    />
                    <div className={styles.conversationComposerActions}>
                      <Button
                        type="submit"
                        className={styles.conversationSend}
                        aria-label="Send message"
                        disabled={message.isPending || messageBody.trim() === ''}
                      >
                        <FontAwesomeIcon icon={faPaperPlane} aria-hidden="true" />
                      </Button>
                      <MutationFeedback
                        pending={message.isPending}
                        {...(message.error === null ? {} : { message: message.error?.message })}
                      />
                    </div>
                  </form>
                )}
              </div>
            </section>
          ) : tab === 'transcripts' ? (
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
              <div className={styles.overviewWorkflow}>
                {diagramQuery.data?.data.diagrams[0] === undefined ? null : (
                  <WorkflowDiagramView diagram={diagramQuery.data.data.diagrams[0]} />
                )}
              </div>
              <aside className={styles.overviewSidebar}>
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
                          parseActivityOutcome(successOutcome) === undefined)
                      }
                      onClick={() => {
                        const outcome =
                          resolutionStatus === RunResolutionStatusValue.Succeeded
                            ? parseActivityOutcome(successOutcome)
                            : undefined;
                        if (
                          resolutionStatus === RunResolutionStatusValue.Succeeded &&
                          outcome === undefined
                        )
                          return;
                        resolveAndRetry.mutate({
                          runId: ambiguousRun.runId,
                          outcome,
                          status: resolutionStatus,
                        });
                      }}
                    >
                      {resolutionStatus === RunResolutionStatusValue.Failed
                        ? 'Resolve and retry'
                        : 'Resolve run'}
                    </Button>
                    {resolutionStatus === RunResolutionStatusValue.Succeeded &&
                      parseActivityOutcome(successOutcome) === undefined && (
                        <p role="alert">
                          The actual activity outcome must be an object with a supported outcome
                          kind.
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

              <section className={styles.overviewMain} aria-labelledby="work-activity">
                <h2 id="work-activity" className={styles.sidebarSectionTitle}>
                  Activity timeline
                </h2>
                {eventsQuery.isPending ? (
                  <LoadingState label="Loading activity" />
                ) : eventsQuery.error ? (
                  <ErrorState error={eventsQuery.error} retry={() => void eventsQuery.refetch()} />
                ) : activityTimeline(query.data.data.execution.runs, eventsQuery.data?.items ?? [])
                    .length ? (
                  <ol className={styles.activityTimeline} aria-label="Activity timeline">
                    {activityTimeline(
                      query.data.data.execution.runs,
                      eventsQuery.data?.items ?? [],
                    ).map((entry) => (
                      <li key={entry.id} className={styles.activityTimelineItem}>
                        <span className={styles.activityTimelineMarker} data-kind={entry.kind} />
                        <LocalTime value={entry.occurredAt} />
                        {entry.kind === 'run' ? (
                          <>
                            <span className={styles.activityTimelineKind} data-kind="run">
                              Run
                            </span>
                            <Link to={`/runs/${encodeURIComponent(entry.run.runId)}`}>
                              {entry.run.activity}
                            </Link>
                            <span className={styles.activityTimelineDetail}>
                              Stage: {entry.run.stage ?? 'Not assigned'}
                            </span>
                            <span className={styles.activityTimelineDetail}>
                              Runner:{' '}
                              {entry.run.runnerName ?? entry.run.runnerModel ?? 'Unassigned'}
                            </span>
                            <span className={styles.activityTimelineOutcome}>
                              Outcome: {runOutcome(entry.run)}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className={styles.activityTimelineKind} data-kind="event">
                              Event
                            </span>
                            <span>{entry.event.type}</span>
                            {entry.event.stream !== undefined && (
                              <span className={styles.activityTimelineDetail}>
                                Stream: {entry.event.stream.kind}
                              </span>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState>No activity yet</EmptyState>
                )}
              </section>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
  return content;
}

function ConversationAvatar({
  actorId,
  sourceAdapter,
}: {
  readonly actorId: string;
  readonly sourceAdapter: string | undefined;
}) {
  const [imageUnavailable, setImageUnavailable] = useState(false);
  const github = sourceAdapter === 'github' && actorId.trim() !== '';
  return (
    <span
      className={styles.conversationAvatar}
      aria-label={github ? `${actorId} GitHub avatar` : actorId}
    >
      {github && !imageUnavailable ? (
        <img
          src={`https://github.com/${encodeURIComponent(actorId)}.png?size=64`}
          alt=""
          onError={() => setImageUnavailable(true)}
        />
      ) : (
        actorId.slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

type ActivityTimelineEntry =
  | {
      readonly id: string;
      readonly kind: 'run';
      readonly occurredAt: string;
      readonly run: RunResponse;
    }
  | {
      readonly id: string;
      readonly kind: 'event';
      readonly occurredAt: string;
      readonly event: AuditEventResponse;
    };

function activityTimeline(
  runs: readonly RunResponse[],
  events: readonly AuditEventResponse[],
): readonly ActivityTimelineEntry[] {
  return [
    ...runs.map((run) => ({
      id: `run:${run.runId}`,
      kind: 'run' as const,
      occurredAt: run.finishedAt ?? run.startedAt,
      run,
    })),
    ...events.map((event) => ({
      id: `event:${event.id}`,
      kind: 'event' as const,
      occurredAt: event.occurredAt,
      event,
    })),
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

function runOutcome(run: RunResponse): string {
  return run.resolution?.sentinel ?? run.sentinel ?? run.status;
}

function isAmbiguousRunBlock(reason: string | undefined): boolean {
  return reason !== undefined && /^run-ambiguous-after-\d+-attempts$/.test(reason);
}

function parseActivityOutcome(value: string): { readonly kind: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const kind = (parsed as { readonly kind?: unknown }).kind;
    return typeof kind === 'string' &&
      Object.values(ActivityOutcomeKindValue).includes(kind as never)
      ? (parsed as { readonly kind: string })
      : undefined;
  } catch {
    return undefined;
  }
}
