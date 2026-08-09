import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

const asOf = '2026-07-31T10:00:00.000Z';

function detailClient() {
  const work = {
    workItemKey: 'wk_a',
    workItemId: 'work-a',
    objective: 'Alpha',
    state: 'open',
    relatedWorkItems: [],
  };
  return new WakeApiClient(async (input) => {
    const url = String(input);
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
              orchestration: { primary: null, children: [] },
              execution: {
                runs: [
                  {
                    runId: 'run-1',
                    activationId: 'activation-1',
                    activity: 'agent',
                    workflowInstanceId: 'workflow-1',
                    orchestrationGroupId: 'group-1',
                    attempt: 1,
                    status: 'succeeded',
                    active: false,
                    startedAt: asOf,
                    finishedAt: asOf,
                    sentinel: 'DONE',
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

describe('work detail', () => {
  afterEach(cleanup);

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
    expect(title.nextElementSibling?.tagName).toBe('NAV');
    expect(screen.getByRole('navigation', { name: 'Work detail sections' }).textContent).toContain(
      'Overview',
    );

    const details = title.parentElement?.querySelector('dl');
    expect(details?.textContent).toMatch(/Work identity.*State.*Workflow.*Stage/);

    const resources = screen.getByRole('list', { name: 'Resources' });
    expect(resources.textContent).not.toContain('rev-9');
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
                orchestration: { primary: null, children: [] },
                execution: { runs: [] },
                activities: {},
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
    await user.click(screen.getByRole('button', { name: 'Events' }));
    expect(await screen.findByText('work.created')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /work.created/ }));
    expect(screen.getByText(/workItemId/)).toBeTruthy();
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
