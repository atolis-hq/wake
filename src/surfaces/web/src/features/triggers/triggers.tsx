import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { TriggerResponse } from '../../../../api/contracts/index.js';
import { useApiClient } from '../../api/context.js';
import { refreshPolicy } from '../../api/refresh-policy.js';
import { DataTable } from '../../components/data-table.js';
import { LocalTime } from '../../components/local-time.js';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
} from '../../components/primitives.js';

export function TriggersList() {
  const client = useApiClient();
  const query = useQuery({
    queryKey: ['triggers'],
    queryFn: ({ signal }) => client.triggers.list(signal),
    refetchInterval: refreshPolicy.status,
  });
  return (
    <>
      <PageHeader title="Triggers" />
      {query.isPending ? (
        <LoadingState label="Loading triggers" />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState>No triggers configured or recorded</EmptyState>
      ) : (
        <DataTable
          caption="Triggers"
          rows={query.data.data}
          rowKey={(entry) => entry.triggerId}
          columns={[
            {
              label: 'Trigger',
              render: (entry) => (
                <Link to={'/triggers/' + encodeURIComponent(entry.triggerId)}>
                  {entry.triggerId}
                </Link>
              ),
            },
            { label: 'Status', render: (entry) => entry.status },
            {
              label: 'Workflow',
              render: (entry) =>
                entry.definition?.workflow ?? entry.invocations[0]?.claim.workflowName ?? '—',
            },
            {
              label: 'Next cron occurrence (UTC)',
              render: (entry) =>
                entry.nextOccurrence ? (
                  <LocalTime value={entry.nextOccurrence} timeZone="UTC" />
                ) : (
                  '—'
                ),
            },
            {
              label: 'Latest invocation',
              render: (entry) => <Invocation entry={entry.invocations[0]} />,
            },
            { label: 'Pause/failure reason', render: (entry) => entry.pauseReason ?? '—' },
            { label: 'Latest skip', render: (entry) => entry.latestSkip?.reason ?? '—' },
            { label: 'Control', render: (entry) => <TriggerControl trigger={entry} /> },
          ]}
        />
      )}
    </>
  );
}

export function TriggerDetail() {
  const { triggerId = '' } = useParams();
  const client = useApiClient();
  const query = useQuery({
    queryKey: ['triggers', triggerId],
    queryFn: ({ signal }) => client.triggers.detail(triggerId, signal),
    refetchInterval: refreshPolicy.status,
  });
  if (query.isPending) return <LoadingState label="Loading trigger" />;
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const trigger = query.data.data;
  return (
    <>
      <PageHeader title={trigger.triggerId} />
      <Link to="/triggers">All triggers</Link>
      <Panel>
        <p>Status: {trigger.status}</p>
        <TriggerControl trigger={trigger} />
        <p>
          Pause leaves active invocations running. Manage cancellation and freezing on their
          WorkItems.
        </p>
        {trigger.pauseReason && <p>Pause reason: {trigger.pauseReason}</p>}
        {trigger.definition === null ? (
          <p>Definition removed. Recorded invocations remain available.</p>
        ) : (
          <>
            <h2>Configuration</h2>
            <pre>{JSON.stringify(trigger.definition, null, 2)}</pre>
          </>
        )}
        {trigger.nextOccurrence && (
          <p>
            Next cron occurrence (UTC): <LocalTime value={trigger.nextOccurrence} timeZone="UTC" />
          </p>
        )}
      </Panel>
      <Panel>
        <h2>Pending requests</h2>
        {trigger.pending.length === 0 ? (
          <p>No pending request</p>
        ) : (
          <pre>{JSON.stringify(trigger.pending, null, 2)}</pre>
        )}
      </Panel>
      <Panel>
        <h2>Latest skipped occurrence</h2>
        {trigger.latestSkip === null ? (
          <p>No recorded skip diagnostic</p>
        ) : (
          <>
            <p>
              {trigger.latestSkip.reason} at <LocalTime value={trigger.latestSkip.occurredAt} />
            </p>
            <pre>{JSON.stringify(trigger.latestSkip.source, null, 2)}</pre>
          </>
        )}
      </Panel>
      <Panel>
        <h2>Invocation history</h2>
        {trigger.invocations.length === 0 ? (
          <EmptyState>No invocations recorded</EmptyState>
        ) : (
          <DataTable
            caption="Invocation history"
            rows={trigger.invocations}
            rowKey={(entry) => entry.claim.workItemId}
            columns={[
              { label: 'WorkItem', render: (entry) => <Invocation entry={entry} /> },
              { label: 'Claimed', render: (entry) => <LocalTime value={entry.claimedAt} /> },
              {
                label: 'Started',
                render: (entry) =>
                  entry.startedAt ? <LocalTime value={entry.startedAt} /> : 'Pending recovery',
              },
              {
                label: 'Finished',
                render: (entry) =>
                  entry.finishedAt ? <LocalTime value={entry.finishedAt} /> : '—',
              },
              { label: 'Reason', render: (entry) => entry.result?.reason ?? '—' },
              {
                label: 'Sources',
                render: (entry) => <pre>{JSON.stringify(entry.claim.sources, null, 2)}</pre>,
              },
            ]}
          />
        )}
      </Panel>
    </>
  );
}

function Invocation({
  entry,
}: {
  readonly entry: TriggerResponse['invocations'][number] | undefined;
}) {
  return entry === undefined ? (
    <>—</>
  ) : (
    <>
      <Link to={'/work/' + encodeURIComponent(entry.workItemKey)}>{entry.claim.workItemId}</Link> (
      {entry.result?.status ?? (entry.startedAt ? 'running' : 'claimed')})
    </>
  );
}

function TriggerControl({ trigger }: { readonly trigger: TriggerResponse }) {
  const client = useApiClient();
  const cache = useQueryClient();
  const command = useMutation({
    mutationFn: (request: { readonly name: 'pause' | 'resume'; readonly idempotencyKey: string }) =>
      client.triggers.command(trigger.triggerId, request.name, request.idempotencyKey),
    onSettled: () => cache.invalidateQueries({ queryKey: ['triggers'] }),
  });
  return (
    <>
      <Button
        type="button"
        disabled={command.isPending}
        onClick={() =>
          command.mutate({
            name: trigger.paused ? 'resume' : 'pause',
            idempotencyKey: 'web:trigger:' + crypto.randomUUID(),
          })
        }
      >
        {trigger.paused ? 'Resume' : 'Pause'}
      </Button>
      {command.error && (
        <ErrorState
          error={command.error}
          retry={() => {
            if (command.variables !== undefined) command.mutate(command.variables);
          }}
        />
      )}
    </>
  );
}
