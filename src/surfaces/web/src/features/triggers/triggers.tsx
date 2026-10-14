import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Markdown from 'react-markdown';
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
import markdownStyles from '../work/markdown-artifact-viewer.module.css';

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
      {query.data && query.data.orphanedInstructions.length > 0 && (
        <Panel>
          <h2>Orphaned operator instructions</h2>
          <p>
            These documents are retained but have no configured trigger using their scope. Configure
            a trigger with the same contextScope to use and edit them again.
          </p>
          {query.data.orphanedInstructions.map((document) => (
            <section key={document.contextScope}>
              <h3>{document.contextScope}</h3>
              <p>
                Document: instructions.md. Saved by {document.author} at{' '}
                <LocalTime value={document.occurredAt} />. Revision: {document.revisionId}
              </p>
              <article
                className={markdownStyles.markdown}
                aria-label={'Orphaned instructions for ' + document.contextScope}
              >
                <Markdown skipHtml>{document.content}</Markdown>
              </article>
            </section>
          ))}
        </Panel>
      )}
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
      <InstructionsEditor key={trigger.triggerId} trigger={trigger} />
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

function InstructionsEditor({ trigger }: { readonly trigger: TriggerResponse }) {
  const client = useApiClient();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [expectedRevisionId, setExpectedRevisionId] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      client.triggers.saveInstructions(
        trigger.triggerId,
        draft ?? '',
        expectedRevisionId,
        'web:instructions:' + crypto.randomUUID(),
      ),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['triggers'] });
      setDraft(null);
    },
  });
  const reload = useMutation({
    mutationFn: async () => {
      const current = await client.triggers.detail(trigger.triggerId);
      cache.setQueryData(['triggers', trigger.triggerId], current);
      setDraft(current.data.operatorInstructions?.content ?? '');
      setExpectedRevisionId(current.data.operatorInstructions?.revisionId ?? null);
      save.reset();
    },
  });
  const scope = trigger.definition?.contextScope;
  return (
    <Panel>
      <h2>Operator standing instructions</h2>
      <p>Document: instructions.md</p>
      {scope === undefined ? (
        <p>
          This trigger has no explicit contextScope. Configure a named scope before editing
          instructions.
        </p>
      ) : (
        <>
          <p>
            Scope: {scope}. Shared by all triggers in this scope. Saves apply to later runs; active
            runs keep their snapshot.
          </p>
          {trigger.operatorInstructions && (
            <p>
              Last saved by {trigger.operatorInstructions.author} at{' '}
              <LocalTime value={trigger.operatorInstructions.occurredAt} />. Revision:{' '}
              {trigger.operatorInstructions.revisionId}
            </p>
          )}
          {draft === null ? (
            <>
              <article
                className={markdownStyles.markdown}
                aria-label="Operator standing instructions"
              >
                {trigger.operatorInstructions === null ||
                trigger.operatorInstructions === undefined ? (
                  <p>
                    No instructions document exists yet. The first operator save creates it; no
                    scope membership or prior invocation is required.
                  </p>
                ) : (
                  <Markdown skipHtml>{trigger.operatorInstructions.content}</Markdown>
                )}
              </article>
              <Button
                onClick={() => {
                  setDraft(trigger.operatorInstructions?.content ?? '');
                  setExpectedRevisionId(trigger.operatorInstructions?.revisionId ?? null);
                  save.reset();
                }}
              >
                Edit instructions
              </Button>
            </>
          ) : (
            <>
              <label>
                Instructions (Markdown)
                <textarea
                  aria-label="Instructions (Markdown)"
                  placeholder="Describe what agents should do on future invocations. These instructions apply to every trigger sharing this context scope, within fixed safety constraints."
                  rows={14}
                  value={draft}
                  disabled={save.isPending}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                Save instructions
              </Button>
              <Button
                disabled={save.isPending}
                onClick={() => {
                  setDraft(null);
                  save.reset();
                }}
              >
                Cancel
              </Button>
              {save.error && (
                <>
                  <p role="alert">{save.error.message}</p>
                  <Button disabled={reload.isPending} onClick={() => reload.mutate()}>
                    Reload current instructions
                  </Button>
                </>
              )}
            </>
          )}
        </>
      )}
      {reload.error && <p role="alert">{reload.error.message}</p>}
    </Panel>
  );
}
