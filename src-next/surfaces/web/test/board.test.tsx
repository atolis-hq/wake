import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/app.js';
import { WakeApiClient } from '../src/api/client.js';

const asOf = '2026-07-31T10:00:00.000Z';

function boardClient(fetchSpy?: (url: string) => void) {
  const items = [
    {
      workItemKey: 'wk_a',
      workItemId: 'work-a',
      objective: 'Alpha',
      state: 'open',
      relatedWorkItems: [],
    },
    {
      workItemKey: 'wk_b',
      workItemId: 'work-b',
      objective: 'Beta',
      state: 'open',
      relatedWorkItems: [],
    },
    {
      workItemKey: 'wk_c',
      workItemId: 'work-c',
      objective: 'Gamma',
      state: 'closed',
      relatedWorkItems: [],
    },
  ];
  return new WakeApiClient(async (input) => {
    const url = String(input);
    fetchSpy?.(url);
    const body = url.includes('/work-items')
      ? { items, page: { nextCursor: null, hasMore: false }, meta: { asOf } }
      : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('board', () => {
  afterEach(cleanup);

  it('labels every column with its item count and keeps empty columns visible', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Open (2)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Closed (1)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cancelled (0)' })).toBeTruthy();
  });

  it('renders each card as a link to its work item key route', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('listitem', { name: 'Alpha' });
    expect(within(card).getByRole('link', { name: 'Alpha' }).getAttribute('href')).toBe(
      '/work/wk_a',
    );
  });

  it('requests only the work item collection, never a second collection to join', async () => {
    const seen: string[] = [];
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient((url) => seen.push(url))} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Open (2)' });
    expect(seen.filter((url) => url.includes('/workflow-instances'))).toEqual([]);
    expect(seen.filter((url) => url.includes('/resources'))).toEqual([]);
  });
});
