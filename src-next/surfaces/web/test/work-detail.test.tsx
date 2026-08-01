import { cleanup, render, screen } from '@testing-library/react';
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
    const body = url.includes('/work-items/wk_a')
      ? {
          data: {
            work,
            resources: [
              {
                resourceId: 'resource-1',
                kind: 'unheard-of-kind',
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

  it('renders an unknown resource kind generically, proving no kind-specific branch', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const resources = await screen.findByRole('list', { name: 'Resources' });
    expect(resources.textContent).toContain('unheard-of-kind');
    expect(resources.textContent).toContain('inspect');
    expect(resources.textContent).toContain('annotate');
    expect(resources.textContent).toContain('resource-1');
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

  it('links each run row to its own route', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'run-1' });
    expect(link.getAttribute('href')).toBe('/runs/run-1');
  });
});
