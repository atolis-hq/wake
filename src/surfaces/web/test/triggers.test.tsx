import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { TriggerStatus, type TriggerResponse } from '../../api/contracts/index.js';
import { WakeApiClient } from '../src/api/client.js';
import { ApiClientContext } from '../src/api/context.js';
import { TriggerDetail, TriggersList } from '../src/features/triggers/triggers.js';

const asOf = '2026-10-13T12:00:00.000Z';
afterEach(cleanup);
function entry(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
  return {
    triggerId: 'oversight',
    activeInvocation: null,
    status: TriggerStatus.Enabled,
    definition: {
      id: 'oversight',
      workflow: 'inspect',
      on: { events: ['work.objective-revised'] },
    },
    paused: false,
    pauseReason: null,
    nextOccurrence: null,
    pending: [],
    latestSkip: null,
    invocations: [],
    ...overrides,
  };
}
function mount(path: string, fetcher: typeof fetch) {
  const client = new WakeApiClient(fetcher);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiClientContext.Provider value={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/triggers" element={<TriggersList />} />
            <Route path="/triggers/:triggerId" element={<TriggerDetail />} />
          </Routes>
        </MemoryRouter>
      </ApiClientContext.Provider>
    </QueryClientProvider>,
  );
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

it('navigates from the list, shows events-only scheduling, pauses and refreshes durable status', async () => {
  let trigger = entry();
  const commands: unknown[] = [];
  mount(
    '/triggers',
    vi.fn(async (input, init) => {
      if (init?.method === 'POST') {
        commands.push(JSON.parse(String(init.body)));
        trigger = entry({
          paused: true,
          pauseReason: 'Operator pause',
          status: TriggerStatus.Paused,
        });
        return json({
          data: {
            commandId: 'pause',
            idempotencyKey: 'key',
            acceptedAt: asOf,
            status: 'completed',
          },
          meta: { asOf },
        });
      }
      return json({
        data: String(input).endsWith('/triggers') ? [trigger] : trigger,
        meta: { asOf },
      });
    }),
  );
  const table = await screen.findByRole('table', { name: 'Triggers' });
  expect(within(table).getByText('enabled')).toBeTruthy();
  expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  fireEvent.click(within(table).getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(within(table).getByText('paused')).toBeTruthy());
  expect(commands).toEqual([expect.objectContaining({ idempotencyKey: expect.any(String) })]);
  fireEvent.click(within(table).getByRole('link', { name: 'oversight' }));
  expect(await screen.findByRole('heading', { name: 'Configuration' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
});

it('retains removed history, links WorkItems and renders actual skip source/time/reason', async () => {
  const trigger = entry({
    status: TriggerStatus.Removed,
    definition: null,
    latestSkip: {
      triggerId: 'oversight',
      occurredAt: asOf,
      reason: 'capacity-unavailable',
      source: { kind: 'cron', slot: asOf },
    },
    invocations: [
      {
        claimedAt: asOf,
        startedAt: asOf,
        workItemKey: 'wk_d29yaw',
        claim: {
          triggerId: 'oversight',
          coordinationKey: 'oversight',
          workflowName: 'inspect',
          workflowInstanceId: 'flow',
          workItemId: 'work',
          source: { kind: 'cron', slot: asOf },
          sources: [{ kind: 'cron', slot: asOf }],
        },
      },
    ],
  });
  mount(
    '/triggers/oversight',
    vi.fn(async () => json({ data: trigger, meta: { asOf } })),
  );
  expect(
    await screen.findByText('Definition removed. Recorded invocations remain available.'),
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: 'work' }).getAttribute('href')).toBe('/work/wk_d29yaw');
  expect(screen.getByText(/capacity-unavailable at/)).toBeTruthy();
  expect(screen.getByText(/Pause leaves active invocations running/)).toBeTruthy();
});

it('shows loading and the empty list', async () => {
  let finish!: (response: Response) => void;
  mount(
    '/triggers',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  expect(screen.getByRole('status').textContent).toContain('Loading triggers');
  finish(json({ data: [], meta: { asOf } }));
  expect(await screen.findByText('No triggers configured or recorded')).toBeTruthy();
});

it.each([404, 403])('shows missing/permission errors (%s)', async (status) => {
  mount(
    '/triggers/missing',
    vi.fn(async () =>
      json(
        { type: 'about:blank', title: status === 404 ? 'Not Found' : 'Forbidden', status },
        status,
      ),
    ),
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText(status === 404 ? 'Not Found' : 'Forbidden')).toBeTruthy();
});

it('shows command permission failures without changing status', async () => {
  mount(
    '/triggers',
    vi.fn(async (_input, init) =>
      init?.method === 'POST'
        ? json({ type: 'about:blank', title: 'Forbidden', status: 403 }, 403)
        : json({ data: [entry()], meta: { asOf } }),
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByText('Forbidden')).toBeTruthy();
  expect(screen.getByText('enabled')).toBeTruthy();
});

it('retries the original command and key after a racing status refresh', async () => {
  let trigger = entry();
  const commands: { readonly url: string; readonly body: unknown }[] = [];
  mount(
    '/triggers',
    vi.fn(async (input, init) => {
      if (init?.method === 'POST') {
        commands.push({ url: String(input), body: JSON.parse(String(init.body)) });
        trigger = entry({
          paused: true,
          pauseReason: 'Operator pause',
          status: TriggerStatus.Paused,
        });
        return commands.length === 1
          ? json({ type: 'about:blank', title: 'Temporary failure', status: 503 }, 503)
          : json({
              data: {
                commandId: 'pause',
                idempotencyKey: 'key',
                acceptedAt: asOf,
                status: 'completed',
              },
              meta: { asOf },
            });
      }
      return json({ data: [trigger], meta: { asOf } });
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[0]!.url).toContain('/commands/pause');
  expect(commands[1]).toEqual(commands[0]);
});

it('edits scope instructions and preserves its draft on a conflicting save', async () => {
  const trigger = entry({
    definition: {
      id: 'oversight',
      workflow: 'inspect',
      contextScope: 'review',
      on: { cron: '* * * * *' },
    },
    operatorInstructions: {
      contextScope: 'review',
      revisionId: 'revision-1',
      content: '# Only ready issues',
      author: 'web',
      occurredAt: asOf,
    },
  });
  const requests: unknown[] = [];
  mount(
    '/triggers/oversight',
    vi.fn(async (_input, init) => {
      if (init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)));
        return json(
          {
            type: 'about:blank',
            status: 409,
            title: 'Conflict',
            detail: 'Instructions changed. Reload before saving; your draft has been preserved.',
          },
          409,
        );
      }
      return json({ data: trigger, meta: { asOf } });
    }),
  );
  expect(await screen.findByRole('heading', { name: 'Only ready issues' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit instructions' }));
  const editor = screen.getByRole('textbox', { name: 'Instructions (Markdown)' });
  fireEvent.change(editor, { target: { value: 'Only urgent issues' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Instructions changed');
  expect((editor as HTMLTextAreaElement).value).toBe('Only urgent issues');
  expect(requests).toEqual([
    expect.objectContaining({ content: 'Only urgent issues', expectedRevisionId: 'revision-1' }),
  ]);
});

it('rejects editing a trigger with no explicit scope without inventing one', async () => {
  mount(
    '/triggers/oversight',
    vi.fn(async () => json({ data: entry(), meta: { asOf } })),
  );
  expect(await screen.findByText(/has no explicit contextScope/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit instructions' })).toBeNull();
});

it('saves operator instructions and renders the refreshed Markdown', async () => {
  let trigger = entry({
    definition: { id: 'oversight', workflow: 'inspect', contextScope: 'review', on: {} },
    operatorInstructions: null,
  });
  mount(
    '/triggers/oversight',
    vi.fn(async (_input, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          content: string;
          expectedRevisionId: string | null;
          idempotencyKey: string;
        };
        expect(body.expectedRevisionId).toBeNull();
        trigger = {
          ...trigger,
          operatorInstructions: {
            contextScope: 'review',
            revisionId: 'saved',
            content: body.content,
            author: 'web',
            occurredAt: asOf,
          },
        };
        return json({
          data: {
            commandId: 'save',
            idempotencyKey: body.idempotencyKey,
            acceptedAt: asOf,
            status: 'completed',
          },
          meta: { asOf },
        });
      }
      return json({ data: trigger, meta: { asOf } });
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit instructions' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Instructions (Markdown)' }), {
    target: { value: '# Ready only' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
  expect(await screen.findByRole('heading', { name: 'Ready only' })).toBeTruthy();
});

it('explains lazy creation and shared scope in the empty editor placeholder', async () => {
  const trigger = entry({
    definition: { id: 'oversight', workflow: 'inspect', contextScope: 'review', on: {} },
    operatorInstructions: null,
  });
  mount(
    '/triggers/oversight',
    vi.fn(async () => json({ data: trigger, meta: { asOf } })),
  );
  expect(await screen.findByText(/No instructions document exists yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit instructions' }));
  const editor = screen.getByPlaceholderText(
    /Describe what agents should do on future invocations/,
  );
  expect((editor as HTMLTextAreaElement).value).toBe('');
  expect(editor.getAttribute('placeholder')).toContain('every trigger sharing this context scope');
});

it('shows orphaned documents when no triggers remain, with safe Markdown and reconnection guidance', async () => {
  mount(
    '/triggers',
    vi.fn(async () =>
      json({
        data: [],
        orphanedInstructions: [
          {
            contextScope: 'old.review',
            revisionId: 'saved',
            content: '# Retained criteria\n<script>bad()</script>',
            author: 'web',
            occurredAt: asOf,
          },
        ],
        meta: { asOf },
      }),
    ),
  );
  expect(
    await screen.findByRole('heading', { name: 'Orphaned operator instructions' }),
  ).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'old.review' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Retained criteria' })).toBeTruthy();
  expect(screen.getByText(/Configure a trigger with the same contextScope/)).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
});

it('retains orphan metadata and reports unavailable content without hiding the Triggers page', async () => {
  mount(
    '/triggers',
    vi.fn(async () =>
      json({
        data: [],
        orphanedInstructions: [
          {
            contextScope: 'retired',
            revisionId: 'saved',
            content: null,
            author: 'web',
            occurredAt: asOf,
          },
        ],
        meta: { asOf },
      }),
    ),
  );
  expect(await screen.findByRole('heading', { name: 'retired' })).toBeTruthy();
  expect(screen.getByText(/Instructions content is unavailable/)).toBeTruthy();
  expect(screen.getByText(/Revision: saved/)).toBeTruthy();
  expect(screen.getByText('No triggers configured or recorded')).toBeTruthy();
});

it.each([
  { disposition: 'started', workItemId: 'work-started' },
  { disposition: 'coalesced', activeWorkItemId: 'work-active' },
  { disposition: 'skipped', reason: 'capacity-unavailable' },
])('runs a configured trigger and shows the $disposition disposition', async (triggerOutcome) => {
  const calls: string[] = [];
  mount(
    '/triggers',
    vi.fn(async (input, init) => {
      if (init?.method === 'POST') {
        calls.push(String(input));
        return json({
          data: {
            commandId: 'manual',
            idempotencyKey: 'key',
            acceptedAt: asOf,
            status: 'completed',
            triggerOutcome,
          },
          meta: { asOf },
        });
      }
      return json({ data: [entry()], meta: { asOf } });
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
  expect((await screen.findByRole('status')).textContent).toContain(
    triggerOutcome.disposition === 'coalesced' ? 'queued' : triggerOutcome.disposition,
  );
  if ('workItemId' in triggerOutcome)
    expect(screen.getByRole('status').textContent).toContain(triggerOutcome.workItemId);
  if ('activeWorkItemId' in triggerOutcome)
    expect(screen.getByRole('status').textContent).toContain(
      'behind ' + triggerOutcome.activeWorkItemId,
    );
  if ('reason' in triggerOutcome)
    expect(screen.getByRole('status').textContent).toContain(triggerOutcome.reason);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('/commands/run');
});

it('explains paused and active manual actions', async () => {
  mount(
    '/triggers',
    vi.fn(async () =>
      json({
        data: [
          entry({ paused: true, status: TriggerStatus.Paused }),
          entry({ triggerId: 'active', status: TriggerStatus.Running }),
        ],
        meta: { asOf },
      }),
    ),
  );
  const buttons = await screen.findAllByRole('button', { name: 'Run now' });
  expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
  expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('Automatic runs paused; Run now still works.')).toBeTruthy();
  expect(screen.getByText('A request will coalesce while this invocation is active.')).toBeTruthy();
});

it('retries a failed manual command with the original idempotency key', async () => {
  const keys: string[] = [];
  mount(
    '/triggers',
    vi.fn(async (_input, init) => {
      if (init?.method === 'POST') {
        keys.push(JSON.parse(String(init.body)).idempotencyKey);
        if (keys.length === 1)
          return json({ title: 'Storage unavailable', detail: 'Try again', status: 503 }, 503);
        return json({
          data: {
            commandId: 'manual',
            idempotencyKey: keys[0],
            acceptedAt: asOf,
            status: 'completed',
            triggerOutcome: { disposition: 'started' },
          },
          meta: { asOf },
        });
      }
      return json({ data: [entry()], meta: { asOf } });
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect((await screen.findByRole('status')).textContent).toBe('started');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

it('shows the blocked holder and queued attribution and retries through the Work command', async () => {
  const trigger = entry({
    activeInvocation: {
      activeWorkItemId: 'blocked-work',
      workItemKey: 'wk_YmxvY2tlZC13b3Jr',
      triggerId: 'sibling',
      workflowInstanceId: 'workflow',
      workflowStatus: 'blocked',
      blockReason: 'unconfigured outcome failed',
      retryEligible: true,
    },
    pending: [
      {
        triggerId: 'oversight',
        coordinationKey: 'shared',
        source: { kind: 'manual', commandId: 'queued', operator: 'web' },
        sources: [{ kind: 'manual', commandId: 'queued', operator: 'web' }],
        disposition: 'coalesced',
        activeWorkItemId: 'blocked-work',
      },
    ],
  });
  const posts: { url: string; body: unknown }[] = [];
  mount(
    '/triggers/oversight',
    vi.fn(async (input, init) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return json(
          {
            data: {
              commandId: 'work:retry',
              idempotencyKey: 'retry',
              acceptedAt: asOf,
              status: 'accepted',
            },
            meta: { asOf },
          },
          202,
        );
      }
      return json({ data: trigger, meta: { asOf } });
    }),
  );
  expect(await screen.findByText('Block reason: unconfigured outcome failed')).toBeTruthy();
  expect(screen.getByText('oversight: Waiting on blocked-work')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry invocation' }));
  expect(await screen.findByText(/Retry accepted/)).toBeTruthy();
  expect(posts).toEqual([
    {
      url: expect.stringContaining('/work-items/wk_YmxvY2tlZC13b3Jr/commands/retry'),
      body: { idempotencyKey: expect.any(String) },
    },
  ]);
});
