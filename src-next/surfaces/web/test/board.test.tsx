import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

const asOf = '2026-07-31T10:00:00.000Z';

function boardClient(fetchSpy?: (url: string) => void) {
  const items = [
    {
      workItemKey: 'wk_a',
      workItemId: 'work-a',
      objective: 'Alpha',
      condition: 'ready',
      workflowName: 'delivery',
      stage: 'implement',
      dwellSince: asOf,
      runCount: 1,
    },
    {
      workItemKey: 'wk_b',
      workItemId: 'work-b',
      objective: 'Beta',
      condition: 'ready',
      workflowName: 'delivery',
      stage: 'implement',
      dwellSince: asOf,
      runCount: 1,
    },
    {
      workItemKey: 'wk_c',
      workItemId: 'work-c',
      objective: 'Gamma',
      condition: 'finished',
      workflowName: 'delivery',
      stage: 'done',
      dwellSince: asOf,
      runCount: 1,
    },
  ];
  return new WakeApiClient(async (input) => {
    const url = String(input);
    fetchSpy?.(url);
    const body = url.includes('/board')
      ? {
          items,
          conditionCounts: { ready: 2, finished: 1 },
          page: { nextCursor: null, hasMore: false },
          meta: { asOf },
        }
      : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('board', () => {
  afterEach(cleanup);

  it('fits all five columns on desktop and stacks them on mobile', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/features/features.module.css'),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /\.board\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s,
    );
    expect(stylesheet).toMatch(
      /@media\s*\(max-width:\s*42rem\)[\s\S]*?\.board\s*\{[^}]*display:\s*block/s,
    );
  });

  it('labels every column with its item count and keeps empty columns visible', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Ready (2)' }, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Finished (1)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Error (0)' })).toBeTruthy();
  });

  it('renders each card as a link to its work item key route', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('listitem', { name: 'Alpha' });
    const link = within(card).getByRole('link', { name: /Alpha/ });
    expect(link.getAttribute('href')).toBe('/work/wk_a');
    expect(link.className).toContain('cardLink');
  });

  it('requests only the work item collection, never a second collection to join', async () => {
    const seen: string[] = [];
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient((url) => seen.push(url))} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Ready (2)' });
    expect(seen.filter((url) => url.includes('/workflow-instances'))).toEqual([]);
    expect(seen.filter((url) => url.includes('/resources'))).toEqual([]);
  });

  it('collapses a column, hides its cards, and persists the choice', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole('button', { name: 'Collapse Ready' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.click(toggle);

    expect(screen.queryByRole('link', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand Ready' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(window.localStorage.getItem('wake:board:collapsed-columns')).toBe('["ready"]');
  });

  it('restores collapsed columns from storage on first render', async () => {
    window.localStorage.setItem('wake:board:collapsed-columns', '["finished"]');
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Expand Finished' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Gamma' })).toBeNull();
    window.localStorage.clear();
  });
});
