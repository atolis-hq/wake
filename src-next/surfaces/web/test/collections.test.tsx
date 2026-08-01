import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { ApiClientContext } from '../src/api/context.js';
import { RunsList } from '../src/features/runs/runs.js';
import { WorkList } from '../src/features/work/work.js';

describe('URL-owned collection navigation', () => {
  afterEach(cleanup);

  it('owns Work search, state, and opaque cursor pagination in the URL', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    renderFeature(
      <WorkList />,
      '/work?search=demo&state=open&cursor=c_initial',
      collectionClient(requests, 'work'),
    );

    expect(await screen.findByDisplayValue('demo')).toBeTruthy();
    expect(screen.getByDisplayValue('Open')).toBeTruthy();
    expect((await screen.findByText('open')).className).toContain('chipOutline');
    await waitFor(() =>
      expect(requests[0]).toBe('/api/v1/work-items?cursor=c_initial&search=demo&state=open'),
    );
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(requests.at(-1)).toContain('cursor=c_next'));
    await user.clear(screen.getByLabelText('Search'));
    await user.type(screen.getByLabelText('Search'), 'revised');
    await waitFor(() => {
      expect(requests.at(-1)).toContain('search=revised');
      expect(requests.at(-1)).not.toContain('cursor=');
    });
  });

  it('requests Runs by the URL cursor and provides historical page controls', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    renderFeature(<RunsList />, '/runs?cursor=c_history', collectionClient(requests, 'runs'));

    await screen.findByRole('table', { name: 'Execution runs' });
    expect(requests[0]).toBe('/api/v1/runs?cursor=c_history');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(requests.at(-1)).toBe('/api/v1/runs?cursor=c_next'));
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(requests.at(-1)).toBe('/api/v1/runs?cursor=c_history'));
  });
});

function renderFeature(element: React.ReactNode, initialEntry: string, client: WakeApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <ApiClientContext.Provider value={client}>{element}</ApiClientContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function collectionClient(requests: string[], kind: 'work' | 'runs') {
  return new WakeApiClient(async (input) => {
    const url = String(input);
    requests.push(url);
    const asOf = '2026-07-31T10:00:00.000Z';
    const items =
      kind === 'work'
        ? [
            {
              workItemKey: 'wk_demo',
              workItemId: 'work-demo',
              objective: 'Demo Wake',
              state: 'open',
              relatedWorkItems: [],
            },
          ]
        : [
            {
              runId: 'run-1',
              activationId: 'activation-1',
              activity: 'implement',
              workflowInstanceId: 'workflow-1',
              orchestrationGroupId: 'group-1',
              attempt: 1,
              status: 'succeeded',
              active: false,
              startedAt: asOf,
            },
          ];
    return new Response(
      JSON.stringify({
        items,
        page: { nextCursor: 'c_next', hasMore: true },
        meta: { asOf, position: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}
