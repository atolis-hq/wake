import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { ApiClientContext } from '../src/api/context.js';
import { queryKeys } from '../src/api/query-keys.js';
import { App } from '../src/app/app.js';
import { WorkDetail } from '../src/features/work/work.js';

const asOf = '2026-07-31T10:00:00.000Z';

function detailClient(
  primary: Record<string, unknown> | null = null,
  commandResponse: Response | undefined = undefined,
  requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [],
  transcripts: {
    readonly groups: readonly Record<string, unknown>[];
    readonly entries: readonly Record<string, unknown>[];
    readonly available?: boolean;
    readonly byGroup?: Readonly<
      Record<
        string,
        { readonly entries: readonly Record<string, unknown>[]; readonly available?: boolean }
      >
    >;
    readonly waitFor?: Promise<void>;
    readonly error?: boolean;
  } = { groups: [], entries: [] },
  lastRunOutcome: string | undefined = 'DONE',
  canCreateConversationEntries = false,
) {
  const work = {
    workItemKey: 'wk_a',
    workItemId: 'work-a',
    objective: 'Alpha',
    state: 'open',
    ...(lastRunOutcome === undefined ? {} : { lastRunOutcome }),
    relatedWorkItems: [],
  };
  return new WakeApiClient(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (
      url.endsWith('/commands/retry') ||
      url.endsWith('/commands/extend') ||
      url.endsWith('/commands/resolve') ||
      url.endsWith('/commands/message')
    )
      return (
        commandResponse ??
        new Response(
          JSON.stringify({
            data: {
              commandId: 'command-1',
              idempotencyKey: 'key-1',
              acceptedAt: asOf,
              status: 'accepted',
            },
            meta: { asOf },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        )
      );
    if (url.includes('/work-items/wk_a/transcripts/')) {
      const response = await transcriptResponse(url, transcripts);
      if (response instanceof Response) return response;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = url.includes('/events')
      ? {
          items: [
            {
              id: 'event-1',
              type: 'work.created',
              occurredAt: asOf,
              position: 1,
              payload: { workItemId: 'work-a' },
            },
          ],
          page: { nextCursor: null, hasMore: false },
          meta: { asOf },
        }
      : url.includes('/workflow-diagrams')
        ? {
            data: {
              diagrams: [
                {
                  id: 'delivery',
                  label: 'Delivery',
                  direction: 'left-to-right',
                  stages: [{ id: 'implement', label: 'Implement', children: [] }],
                  transitions: [],
                },
              ],
            },
            meta: { asOf },
          }
        : url.includes('/work-items/wk_a')
          ? {
              data: {
                work,
                resources: [
                  {
                    resourceId: 'resource-1',
                    adapter: 'unknown-adapter',
                    kind: 'unheard-of-kind',
                    locatorLabel: 'unheard-of-kind resource-1',
                    capabilities: ['inspect', 'annotate'],
                    revision: 'rev-9',
                  },
                ],
                orchestration: {
                  primary: primary === null ? null : { workItemKey: 'wk_a', ...primary },
                  children: [],
                  diagram: { href: '/api/v1/workflow-diagrams?workItemKey=wk_a' },
                },
                execution: {
                  transcriptGroups: transcripts.groups,
                  runs: [
                    {
                      runId: 'run-1',
                      activationId: 'activation-1',
                      activity: 'agent',
                      workflowInstanceId: 'workflow-1',
                      orchestrationGroupId: 'group-1',
                      attempt: 1,
                      status:
                        primary?.blockReason === 'run-ambiguous-after-3-attempts'
                          ? 'ambiguous'
                          : 'succeeded',
                      active: false,
                      startedAt: asOf,
                      finishedAt: asOf,
                      sentinel:
                        primary?.blockReason === 'run-ambiguous-after-3-attempts'
                          ? 'AMBIGUOUS'
                          : 'DONE',
                      workflowName: 'delivery',
                      stage: 'implement',
                      totalTokens: 0,
                      totalCostUsd: 0,
                    },
                  ],
                },
                activities: {
                  pullRequest: {
                    resourceId: 'resource-1',
                    state: 'open',
                    headRevision: 'abc123',
                    baseRevision: 'def456',
                    checks: 'passing',
                  },
                },
                conversation: { entries: [], canCreateEntries: canCreateConversationEntries },
              },
              meta: { asOf },
            }
          : url.includes('/work-items')
            ? { items: [work], page: { nextCursor: null, hasMore: false }, meta: { asOf } }
            : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function transcriptResponse(
  url: string,
  transcripts: {
    readonly entries: readonly Record<string, unknown>[];
    readonly available?: boolean;
    readonly byGroup?: Readonly<
      Record<
        string,
        { readonly entries: readonly Record<string, unknown>[]; readonly available?: boolean }
      >
    >;
    readonly waitFor?: Promise<void>;
    readonly error?: boolean;
  },
) {
  await transcripts.waitFor;
  if (transcripts.error)
    return new Response(
      JSON.stringify({ type: 'about:blank', title: 'Transcript read failed', status: 500 }),
      {
        status: 500,
        headers: { 'content-type': 'application/problem+json' },
      },
    );
  const groupId = decodeURIComponent(url.split('/').at(-1) ?? '');
  const group = transcripts.byGroup?.[groupId];
  return {
    data: {
      groupId,
      available: group?.available ?? transcripts.available ?? true,
      entries: group?.entries ?? transcripts.entries,
    },
    meta: { asOf },
  };
}

describe('work detail', () => {
  afterEach(cleanup);

  it('places the mocked workflow diagram above runs in the overview main area', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient({
            workflowInstanceId: 'workflow-1',
            workflowName: 'delivery',
            orchestrationGroupId: 'group-1',
            status: 'active',
            currentStage: 'implement',
          })}
        />
      </MemoryRouter>,
    );

    const diagram = await screen.findByLabelText('Workflow Delivery');
    const runs = screen.getByRole('table', { name: 'Runs' });
    expect(diagram.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('presents labelled sections rather than a raw structure dump', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Resources' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Runs' })).toBeTruthy();
  });

  it('places overview navigation before sidebar actions and hides resource revisions', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const title = await screen.findByRole('heading', { name: 'Alpha' });
    expect(title.nextElementSibling?.getAttribute('role')).toBe('tablist');
    expect(screen.getByRole('tablist', { name: 'Work detail sections' }).textContent).toContain(
      'Overview',
    );

    const details = title.parentElement?.querySelector('dl');
    expect(details?.textContent).toMatch(/Work identity.*State.*Workflow.*Stage.*Last run/);

    const resources = screen.getByRole('list', { name: 'Resources' });
    expect(resources.textContent).not.toContain('rev-9');
  });

  it('shows a distinct clarification pill from work.lastRunOutcome', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(
            null,
            undefined,
            [],
            { groups: [], entries: [] },
            'NEEDS_CLARIFICATION',
          )}
        />
      </MemoryRouter>,
    );

    const outcome = await screen.findByText('needs clarification');
    expect(outcome.className).toContain('info');
  });

  it('uses accessible tab and tabpanel semantics for detail sections', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const tablist = await screen.findByRole('tablist', { name: 'Work detail sections' });
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview.getAttribute('aria-selected')).toBe('true');
    expect(overview.getAttribute('aria-controls')).toBe('work-detail-overview-panel');
    expect(screen.getByRole('tabpanel', { name: 'Overview' }).id).toBe(
      'work-detail-overview-panel',
    );
    expect(tablist.contains(overview)).toBe(true);

    await user.click(screen.getByRole('tab', { name: 'Events' }));
    expect(screen.getByRole('tab', { name: 'Events' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Events' }).id).toBe('work-detail-events-panel');
  });

  it('does not offer a message composer when control-plane messages are disabled', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('tab', { name: 'Conversation' }));
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  });

  it('records an operator message from the dedicated Conversation tab', async () => {
    const user = userEvent.setup();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient(null, undefined, requests, undefined, 'DONE', true)} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('tab', { name: 'Conversation' }));
    expect(screen.getByRole('tabpanel', { name: 'Conversation' }).id).toBe(
      'work-detail-conversation-panel',
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Please continue.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(requests.filter(({ url }) => url.endsWith('/commands/message'))).toHaveLength(1),
    );
    const message = requests.find(({ url }) => url.endsWith('/commands/message'));
    expect(message?.init?.method).toBe('POST');
    expect(JSON.parse(String(message?.init?.body))).toMatchObject({ body: 'Please continue.' });
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      '',
    );
  });

  it('uses APG keyboard navigation to move and activate work detail tabs', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const overview = await screen.findByRole('tab', { name: 'Overview' });
    const conversation = screen.getByRole('tab', { name: 'Conversation' });
    const events = screen.getByRole('tab', { name: 'Events' });
    const transcripts = screen.getByRole('tab', { name: 'Transcripts' });
    expect(overview.tabIndex).toBe(0);
    expect(events.tabIndex).toBe(-1);

    overview.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(conversation);
    expect(conversation.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(transcripts);
    expect(transcripts.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(overview);
    expect(overview.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(overview);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(transcripts);
  });

  it('places work actions below the detail panel in the overview sidebar', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const details = await screen.findByText('Work identity');
    const freeze = screen.getByRole('button', { name: 'Freeze' });
    expect(details.compareDocumentPosition(freeze) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('hides Retry without an eligible primary workflow', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    unmount();

    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient({
            workflowInstanceId: 'workflow-1',
            workflowName: 'delivery',
            orchestrationGroupId: 'group-1',
            status: 'blocked',
            currentStage: 'implement',
            retryEligible: false,
          })}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('posts Retry and refreshes the work detail when the primary workflow is eligible', async () => {
    const user = userEvent.setup();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(
            {
              workflowInstanceId: 'workflow-1',
              workflowName: 'delivery',
              orchestrationGroupId: 'group-1',
              status: 'blocked',
              currentStage: 'implement',
              retryEligible: true,
            },
            undefined,
            requests,
          )}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(requests.filter(({ url }) => url.endsWith('/commands/retry'))).toHaveLength(1),
    );
    expect(requests.filter(({ url }) => url.includes('/work-items/wk_a'))).toHaveLength(3);
    expect(requests.find(({ url }) => url.endsWith('/commands/retry'))?.init?.method).toBe('POST');
  });

  it('posts Extend when the primary workflow has an exhausted gate budget', async () => {
    const user = userEvent.setup();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(
            {
              workflowInstanceId: 'workflow-1',
              workflowName: 'delivery',
              orchestrationGroupId: 'group-1',
              status: 'blocked',
              currentStage: 'implement',
              extendEligible: true,
            },
            undefined,
            requests,
          )}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Extend' }));
    await waitFor(() =>
      expect(requests.filter(({ url }) => url.endsWith('/commands/extend'))).toHaveLength(1),
    );
    expect(requests.find(({ url }) => url.endsWith('/commands/extend'))?.init?.method).toBe('POST');
  });

  it('shows a Retry command failure', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(
            {
              workflowInstanceId: 'workflow-1',
              workflowName: 'delivery',
              orchestrationGroupId: 'group-1',
              status: 'blocked',
              currentStage: 'implement',
              retryEligible: true,
            },
            new Response(
              JSON.stringify({ type: 'about:blank', title: 'Retry rejected', status: 409 }),
              {
                status: 409,
                headers: { 'content-type': 'application/problem+json' },
              },
            ),
          )}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Retry rejected')).toBeTruthy();
  });

  it('shows ambiguous-run facts and resolves the run before retrying', async () => {
    const user = userEvent.setup();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(
            {
              workflowInstanceId: 'workflow-1',
              workflowName: 'delivery',
              orchestrationGroupId: 'group-1',
              status: 'blocked',
              currentStage: 'implement',
              blockReason: 'run-ambiguous-after-3-attempts',
            },
            undefined,
            requests,
          )}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Resolve ambiguous run' })).toBeTruthy();
    expect(screen.getByText('Recorded for this work item')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Resolve and retry' }));
    await waitFor(() =>
      expect(requests.filter(({ url }) => url.endsWith('/commands/resolve'))).toHaveLength(1),
    );
    expect(requests.filter(({ url }) => url.endsWith('/commands/retry'))).toHaveLength(1);
    const resolve = requests.find(({ url }) => url.endsWith('/commands/resolve'));
    expect(resolve?.init?.method).toBe('POST');
    expect(JSON.parse(String(resolve?.init?.body))).toMatchObject({ status: 'failed' });
  });

  it('sends the operator-confirmed outcome when resolving an ambiguous run as succeeded', async () => {
    const user = userEvent.setup();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(
            {
              workflowInstanceId: 'workflow-1',
              workflowName: 'delivery',
              orchestrationGroupId: 'group-1',
              status: 'blocked',
              currentStage: 'implement',
              blockReason: 'run-ambiguous-after-3-attempts',
            },
            undefined,
            requests,
          )}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('radio', { name: 'Succeeded' }));
    await user.click(screen.getByRole('button', { name: 'Resolve run' }));

    await waitFor(() =>
      expect(requests.filter(({ url }) => url.endsWith('/commands/resolve'))).toHaveLength(1),
    );
    expect(requests.filter(({ url }) => url.endsWith('/commands/retry'))).toHaveLength(0);
    const resolve = requests.find(({ url }) => url.endsWith('/commands/resolve'));
    expect(JSON.parse(String(resolve?.init?.body))).toMatchObject({
      status: 'succeeded',
      outcome: { kind: 'done', data: { status: 'DONE' } },
    });
  });

  it.each(['null', '[]', '{}', '{"kind":"unsupported"}'])(
    'does not submit an invalid succeeded outcome: %s',
    async (outcome) => {
      const user = userEvent.setup();
      const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
      render(
        <MemoryRouter initialEntries={['/work/wk_a']}>
          <App
            client={detailClient(
              {
                workflowInstanceId: 'workflow-1',
                workflowName: 'delivery',
                orchestrationGroupId: 'group-1',
                status: 'blocked',
                currentStage: 'implement',
                blockReason: 'run-ambiguous-after-3-attempts',
              },
              undefined,
              requests,
            )}
          />
        </MemoryRouter>,
      );
      await user.click(await screen.findByRole('radio', { name: 'Succeeded' }));
      const input = screen.getByRole('textbox', { name: 'Actual activity outcome (JSON)' });
      fireEvent.change(input, { target: { value: outcome } });

      expect(screen.getByRole('button', { name: 'Resolve run' })).toMatchObject({ disabled: true });
      expect(screen.getByRole('alert').textContent).toContain(
        'object with a supported outcome kind',
      );
      expect(requests.filter(({ url }) => url.endsWith('/commands/resolve'))).toHaveLength(0);
    },
  );

  it('renders an unknown resource kind generically, proving no kind-specific branch', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const resources = await screen.findByRole('list', { name: 'Resources' });
    expect(resources.textContent).toContain('unheard-of-kind resource-1');
    expect(resources.textContent).toContain('inspect');
    expect(resources.textContent).toContain('annotate');
    expect(screen.queryByRole('link', { name: /unheard-of-kind/ })).toBeNull();
  });

  it('links a resource with a title and resolved external URL', async () => {
    const work = {
      workItemKey: 'wk_a',
      workItemId: 'work-a',
      objective: 'Alpha',
      state: 'open',
      relatedWorkItems: [],
    };
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      const body = url.includes('/events')
        ? { items: [], page: { nextCursor: null, hasMore: false }, meta: { asOf } }
        : url.includes('/work-items/wk_a')
          ? {
              data: {
                work,
                resources: [
                  {
                    resourceId: 'resource-1',
                    adapter: 'github',
                    kind: 'issue',
                    locatorLabel: 'issue owner/repo#412',
                    title: 'Fix flaky checkout test',
                    externalUrl: 'https://github.com/owner/repo/issues/412',
                    capabilities: ['commentable'],
                  },
                ],
                orchestration: {
                  primary: null,
                  children: [],
                  diagram: { href: '/api/v1/workflow-diagrams?workItemKey=wk_a' },
                },
                execution: { runs: [], transcriptGroups: [] },
                activities: {},
                conversation: { entries: [] },
              },
              meta: { asOf },
            }
          : url.includes('/work-items')
            ? { items: [work], page: { nextCursor: null, hasMore: false }, meta: { asOf } }
            : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={client} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: /Fix flaky checkout test/ });
    expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/issues/412');
    expect(link.textContent).toContain('issue owner/repo#412');
  });

  it('renders no activity-specific section even when a pull request is present', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Resources' });
    expect(screen.queryByText(/pull request/i)).toBeNull();
    expect(screen.queryByText('abc123')).toBeNull();
    expect(screen.queryByText('def456')).toBeNull();
  });

  it('shows scoped events in the Events tab and expands their payload', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Alpha' });
    await user.click(screen.getByRole('tab', { name: 'Events' }));
    expect(await screen.findByText('work.created')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /work.created/ }));
    expect(screen.getByText(/workItemId/)).toBeTruthy();
  });

  it('renders a grouped transcript conversation with literal messages and run separators', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(null, undefined, [], {
            groups: [
              {
                groupId: 'run--fallback',
                kind: 'run',
                latestAt: '2026-07-31T11:00:00.000Z',
                runIds: ['run-3'],
              },
              {
                groupId: 'session--opaque-identity',
                kind: 'session',
                cli: 'codex',
                latestAt: '2026-07-31T10:00:00.000Z',
                runIds: ['run-1', 'run-2'],
              },
            ],
            entries: [
              {
                occurredAt: '2026-07-31T10:02:00.000Z',
                channel: 'agent',
                text: 'Reply <b>as literal text</b>',
                runId: 'run-2',
                groupId: 'session--opaque-identity',
                durationMs: 2_000,
              },
              {
                occurredAt: '2026-07-31T10:01:00.000Z',
                channel: 'input',
                text: 'Prompt\nwith a second line',
                runId: 'run-1',
                groupId: 'session--opaque-identity',
                durationMs: 9_000,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));

    const groups = await screen.findByRole('list', { name: 'Transcript groups' });
    expect(groups.textContent).toMatch(/session--opaque-identity.*codex.*run-1.*run-2/);
    expect(groups.textContent).toMatch(/run--fallback/);
    expect(groups.firstElementChild?.textContent).toContain('session--opaque-identity');

    const input = await screen.findByRole('article', { name: 'Input message from run-1' });
    expect(screen.getByRole('article', { name: 'Agent message from run-2' })).toBeTruthy();
    expect(screen.getByText('Reply <b>as literal text</b>')).toBeTruthy();
    expect(screen.queryByText('as literal text', { selector: 'b' })).toBeNull();
    expect(screen.getByText('2s')).toBeTruthy();
    expect(input.textContent).not.toContain('9s');
    const inputText = input.querySelector('pre');
    expect(inputText?.textContent).toBe('Prompt\nwith a second line');
    expect(getComputedStyle(inputText!).whiteSpace).toBe('pre-wrap');
    expect(screen.getByLabelText(/exact UTC 2026-07-31T10:02:00.000Z/)).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Run run-2' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'This run only' })).toBeTruthy();

    await user.click(screen.getByRole('checkbox', { name: 'This run only' }));
    expect(screen.queryByRole('article', { name: 'Input message from run-1' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Agent message from run-2' })).toBeTruthy();
  });

  it('shows an unavailable transcript group state', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(null, undefined, [], {
            groups: [
              {
                groupId: 'run--expired',
                kind: 'run',
                latestAt: asOf,
                runIds: ['run-1'],
              },
            ],
            entries: [],
            available: false,
          })}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));
    expect(await screen.findByText('Transcript unavailable')).toBeTruthy();
  });

  it('shows an empty transcript index without requesting a conversation', async () => {
    const user = userEvent.setup();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient(null, undefined, requests)} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));
    expect(await screen.findByText('No transcript conversations')).toBeTruthy();
    expect(requests.some(({ url }) => url.includes('/transcripts/'))).toBe(false);
  });

  it('shows an empty available transcript conversation', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(null, undefined, [], {
            groups: [{ groupId: 'run--empty', kind: 'run', latestAt: asOf, runIds: ['run-1'] }],
            entries: [],
          })}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));
    expect(await screen.findByText('No transcript messages')).toBeTruthy();
  });

  it('loads the selected conversation and requests the selected opaque group', async () => {
    const user = userEvent.setup();
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(null, undefined, requests, {
            groups: [
              { groupId: 'session--first', kind: 'session', latestAt: asOf, runIds: ['run-1'] },
              { groupId: 'session--second', kind: 'session', latestAt: asOf, runIds: ['run-2'] },
            ],
            entries: [],
            byGroup: {
              'session--second': {
                entries: [
                  {
                    occurredAt: asOf,
                    channel: 'agent',
                    text: 'Second conversation',
                    runId: 'run-2',
                    groupId: 'session--second',
                  },
                ],
              },
            },
          })}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));
    await user.click(await screen.findByRole('button', { name: /session--second/ }));
    expect(await screen.findByText('Second conversation')).toBeTruthy();
    expect(requests.some(({ url }) => url.endsWith('/transcripts/session--second'))).toBe(true);
  });

  it('shows transcript loading and an error with retry', async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const waitForTranscript = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const groups = [{ groupId: 'run--failure', kind: 'run', latestAt: asOf, runIds: ['run-1'] }];
    const { unmount } = render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(null, undefined, requests, {
            groups,
            entries: [],
            waitFor: waitForTranscript,
          })}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));
    expect(await screen.findByText(/Loading transcript/)).toBeTruthy();
    release?.();
    expect(await screen.findByText('No transcript messages')).toBeTruthy();
    unmount();

    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App
          client={detailClient(null, undefined, requests, { groups, entries: [], error: true })}
        />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Transcript read failed');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(requests.filter(({ url }) => url.endsWith('/transcripts/run--failure'))).toHaveLength(
        3,
      ),
    );
  });

  it('validates the selected run when a refreshed group index removes the selected group', async () => {
    const user = userEvent.setup();
    const groups: Record<string, unknown>[] = [
      { groupId: 'session--first', kind: 'session', latestAt: asOf, runIds: ['run-1', 'run-3'] },
      { groupId: 'session--second', kind: 'session', latestAt: asOf, runIds: ['run-2'] },
    ];
    const client = detailClient(null, undefined, [], {
      groups,
      entries: [],
      byGroup: {
        'session--first': {
          entries: [
            {
              occurredAt: asOf,
              channel: 'agent',
              text: 'First run',
              runId: 'run-1',
              groupId: 'session--first',
            },
            {
              occurredAt: '2026-07-31T10:01:00.000Z',
              channel: 'agent',
              text: 'Newest run',
              runId: 'run-3',
              groupId: 'session--first',
            },
          ],
        },
        'session--second': {
          entries: [
            {
              occurredAt: asOf,
              channel: 'agent',
              text: 'Second run',
              runId: 'run-2',
              groupId: 'session--second',
            },
          ],
        },
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <QueryClientProvider client={queryClient}>
          <ApiClientContext.Provider value={client}>
            <Routes>
              <Route path="/work/:workItemKey" element={<WorkDetail />} />
            </Routes>
          </ApiClientContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Transcripts' }));
    await user.click(await screen.findByRole('button', { name: /session--second/ }));
    expect(await screen.findByText('Second run')).toBeTruthy();

    groups.splice(1, 1);
    await act(() =>
      queryClient.refetchQueries({ queryKey: queryKeys.work.detail('wk_a'), type: 'active' }),
    );
    expect(
      ((await screen.findByRole('combobox', { name: 'Run' })) as HTMLSelectElement).value,
    ).toBe('run-3');
    await user.click(screen.getByRole('checkbox', { name: 'This run only' }));
    expect(await screen.findByText('Newest run')).toBeTruthy();
    expect(screen.queryByText('First run')).toBeNull();
  });

  it('links each run row to its own route', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'run-1' });
    expect(link.getAttribute('href')).toBe('/runs/run-1');
    expect(screen.getByRole('cell', { name: 'delivery' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'implement' })).toBeTruthy();
  });
});
