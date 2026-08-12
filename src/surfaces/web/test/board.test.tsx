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
      frozen: true,
      workflowName: 'delivery',
      stage: 'implement',
      dwellSince: asOf,
      runCount: 1,
      lastRunAt: asOf,
      lastRunAgeMs: 125_000,
      totalTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 300_000,
      activeRun: { action: 'pr-review', runnerName: 'fake', startedAt: asOf, elapsedMs: 12_000 },
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
      totalTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
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
      totalTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
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

  it('keeps semantic colors on outlined board status chips', () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/components/components.module.css'),
      'utf8',
    );

    expect(stylesheet).toMatch(/\.chipOutline\.bad\s*\{[^}]*color:\s*var\(--bad\)/s);
    expect(stylesheet).toMatch(/\.chipOutline\.cold\s*\{[^}]*color:\s*#7dd3fc/s);
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

  it('shows run count, last-run recency, total duration, cost, and tokens on the stats line', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('listitem', { name: 'Alpha' });
    expect(
      within(card).getByText('1 runs · last run 2m ago · 5m total · $0.0000 · 0 tokens'),
    ).toBeTruthy();
  });
  it('shows the child-run indicator only for a work item with an active child run', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );
    const active = await screen.findByRole('listitem', { name: 'Alpha' });
    const inactive = screen.getByRole('listitem', { name: 'Beta' });
    expect(within(active).getByText('pr-review running')).toBeTruthy();
    expect(within(inactive).queryByText(/running/i)).toBeNull();
  });
  it('shows the last run outcome returned by the board API', async () => {
    const client = new WakeApiClient(async (input) => {
      const body = String(input).includes('/board')
        ? {
            items: [
              {
                workItemKey: 'wk_failed',
                workItemId: 'work-failed',
                objective: 'Failed work',
                condition: 'error',
                dwellSince: asOf,
                runCount: 1,
                lastRunOutcome: 'failed',
                totalTokens: 0,
                totalCostUsd: 0,
                totalDurationMs: 0,
              },
            ],
            conditionCounts: { error: 1 },
            page: { nextCursor: null, hasMore: false },
            meta: { asOf },
          }
        : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );

    const outcome = await screen.findByText('failed');
    expect(outcome.className).toContain('chip');
    expect(outcome.className).toContain('chipOutline');
    expect(outcome.className).toContain('bad');
  });
  it('does not show the last run outcome badge when it is done', async () => {
    const client = new WakeApiClient(async (input) => {
      const body = String(input).includes('/board')
        ? {
            items: [
              {
                workItemKey: 'wk_done',
                workItemId: 'work-done',
                objective: 'Done work',
                condition: 'finished',
                dwellSince: asOf,
                runCount: 1,
                lastRunOutcome: 'done',
                totalTokens: 0,
                totalCostUsd: 0,
                totalDurationMs: 0,
              },
            ],
            conditionCounts: { finished: 1 },
            page: { nextCursor: null, hasMore: false },
            meta: { asOf },
          }
        : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );

    const card = await screen.findByRole('listitem', { name: 'Done work' });
    expect(within(card).queryByText('done')).toBeNull();
  });
  it('shows an awaiting approval status for work in the Needs Input column', async () => {
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      const body = url.includes('/board')
        ? {
            items: [
              {
                workItemKey: 'wk_approval',
                workItemId: 'work-approval',
                objective: 'Approval required',
                condition: 'needs-input',
                awaitingApproval: true,
                dwellSince: asOf,
                runCount: 1,
                totalTokens: 0,
                totalCostUsd: 0,
                totalDurationMs: 0,
              },
            ],
            conditionCounts: { 'needs-input': 1 },
            page: { nextCursor: null, hasMore: false },
            meta: { asOf },
          }
        : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Needs Input (1)' })).toBeTruthy();
    expect(screen.getByText('awaiting approval')).toBeTruthy();
  });

  it('shows a frozen indicator only for a frozen work item', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={boardClient()} />
      </MemoryRouter>,
    );

    const frozen = await screen.findByRole('listitem', { name: 'Alpha' });
    const unfrozen = screen.getByRole('listitem', { name: 'Beta' });

    const indicator = within(frozen).getByTitle(
      'Automatic progress is paused while this work item is frozen',
    );
    expect(indicator.textContent).toContain('frozen');
    expect(indicator.className).toContain('chip');
    expect(indicator.className).toContain('chipOutline');
    expect(indicator.className).toContain('cold');
    expect(within(unfrozen).queryByText('frozen')).toBeNull();
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
