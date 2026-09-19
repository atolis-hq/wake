import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

describe('Wake operator app', () => {
  afterEach(cleanup);
  it('filters and sorts sidebar items and selects work in the main panel', async () => {
    const user = userEvent.setup();
    setDesktop(false);
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App
          client={client({
            workItems: [
              {
                workItemKey: 'wk_demo',
                workItemId: 'work-demo',
                objective: 'Zulu task',
                state: 'open',
                relatedWorkItems: [],
                externalRef: '#21',
                extendEligible: true,
              },
              {
                workItemKey: 'wk_alpha',
                workItemId: 'work-alpha',
                objective: 'Alpha task',
                state: 'open',
                relatedWorkItems: [],
                externalRef: '#22',
              },
              {
                workItemKey: 'wk_done',
                workItemId: 'work-done',
                objective: 'Done task',
                state: 'closed',
                relatedWorkItems: [],
                condition: 'finished',
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' });
    const finished = within(sidebar).getByText('Finished').closest('details');
    expect(finished?.open).toBe(false);
    await user.selectOptions(within(sidebar).getByLabelText('Sort work items'), 'title');
    const workLinks = sidebar.querySelectorAll('[data-work-item]');
    expect(workLinks[0]?.textContent).toContain('Alpha task');
    expect(within(sidebar).getByText('Needs extension')).toBeTruthy();
    await user.click(within(sidebar).getByRole('button', { name: 'Filter work items' }));
    await user.type(within(sidebar).getByRole('textbox', { name: 'Search work items' }), '#21');
    expect(within(sidebar).queryByRole('link', { name: /Alpha task/ })).toBeNull();
    await user.click(within(sidebar).getByRole('link', { name: /Zulu task/ }));
    expect(
      await within(screen.getByRole('main')).findByRole('heading', { name: /Zulu task/ }),
    ).toBeTruthy();
    expect(
      within(sidebar)
        .getByRole('link', { name: /Zulu task/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resizes the sidebar with the keyboard and remembers collapse and width', async () => {
    localStorage.clear();
    setDesktop(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    const resize = await screen.findByRole('separator', { name: 'Resize sidebar' });
    resize.focus();
    await user.keyboard('{ArrowRight}');
    expect(resize.getAttribute('aria-valuenow')).toBe('296');
    expect(localStorage.getItem('wake:sidebar:width')).toBe('296');
    await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(
      screen.getByRole('button', { name: 'Toggle sidebar' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(localStorage.getItem('wake:sidebar:collapsed')).toBe('true');
    localStorage.clear();
  });

  it('opens a mobile drawer and returns focus on Escape', async () => {
    setDesktop(true);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole('button', { name: 'Toggle sidebar' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('main', { hidden: true }).hasAttribute('inert')).toBe(true);
    await user.keyboard('{Escape}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
  });

  it('shows only the Wake logo in the login brand pane', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App client={client({ authenticated: false })} />
      </MemoryRouter>,
    );

    const logo = await screen.findByRole('img', { name: 'Wake logo' });
    expect(logo.closest('.wake-login-brand')?.textContent).toBe('');
  });

  it('keeps the login brand pane compact around its centered logo', () => {
    const styles = readFileSync('src/styles/global.css', 'utf8');
    expect(styles).toContain('grid-template-columns: minmax(12rem, 14rem) minmax(22rem, 1fr);');
    expect(styles).toContain('justify-content: center;');
  });

  it('redirects its clean root route to the board', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Ready (1)' })).toBeTruthy();
  });

  it('renders a persistent semantic shell with clean route links and independent status', async () => {
    render(
      <MemoryRouter initialEntries={['/work']}>
        <App client={client()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Board' }).getAttribute('href')).toBe('/board');
    expect(screen.getByRole('link', { name: 'Work items' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(await screen.findByText('Dispatch active')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Work items' })).toBeTruthy();
  });

  it('keeps dispatch controls in the single header', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    const banner = await screen.findByRole('banner');
    expect(banner.textContent).toContain('Wake');
    expect(screen.getByRole('img', { name: 'Wake logo' }).getAttribute('src')).toMatch(
      /^data:image\/svg\+xml/,
    );
    await screen.findByText('Dispatch active');
    const status = screen.getByRole('status', { name: 'Control plane' });
    expect(status.textContent).toContain('Dispatch active');
    expect(within(banner).getByText('Dispatch active')).toBeTruthy();
  });

  it('keeps empty and error states inside their feature route', async () => {
    const empty = client({ workItems: [] });
    const { unmount } = render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={empty} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No work items')).toBeTruthy();
    unmount();

    render(
      <MemoryRouter initialEntries={['/health']}>
        <App client={client({ failHealth: true })} />
      </MemoryRouter>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('Health unavailable');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  it('opens work details in the main panel on desktop and mobile', async () => {
    const background = { pathname: '/board', search: '', hash: '', state: null, key: 'board' };
    setDesktop(true);
    const desktop = render(
      <MemoryRouter initialEntries={[{ pathname: '/work/wk_demo', state: { background } }]}>
        <App client={client()} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Demo Wake' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Demo Wake' })).toBeTruthy();
    expect(
      within(screen.getByRole('main')).getByRole('heading', { name: 'Demo Wake' }),
    ).toBeTruthy();
    desktop.unmount();

    setDesktop(false);
    render(
      <MemoryRouter initialEntries={[{ pathname: '/work/wk_demo', state: { background } }]}>
        <App client={client()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Demo Wake' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

function client(
  options: {
    workItems?: readonly {
      readonly workItemKey: string;
      readonly workItemId: string;
      readonly objective: string;
      readonly state: string;
      readonly relatedWorkItems: readonly unknown[];
      readonly condition?: string;
      readonly externalRef?: string;
      readonly extendEligible?: boolean;
    }[];
    failHealth?: boolean;
    authenticated?: boolean;
  } = {},
) {
  const asOf = '2026-07-31T10:00:00.000Z';
  return new WakeApiClient(async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/session'))
      return new Response(JSON.stringify({ authenticated: options.authenticated ?? true }), {
        status: options.authenticated === false ? 401 : 200,
        headers: { 'content-type': 'application/json' },
      });
    if (options.failHealth && url.endsWith('/system/health'))
      return new Response(
        JSON.stringify({ type: 'about:blank', title: 'Health unavailable', status: 500 }),
        { status: 500, headers: { 'content-type': 'application/problem+json' } },
      );
    const items: NonNullable<typeof options.workItems> = options.workItems ?? [
      {
        workItemKey: 'wk_demo',
        workItemId: 'work-demo',
        objective: 'Demo Wake',
        state: 'open',
        relatedWorkItems: [],
      },
    ];
    const data = url.endsWith('/control-plane/status')
      ? { dispatchPaused: false, updatedAt: asOf }
      : url.endsWith('/system/health')
        ? { status: 'ok', version: '0.1.0-test', checkedAt: asOf, checks: [] }
        : url.endsWith('/work-items/wk_demo')
          ? {
              work: items[0],
              resources: [],
              orchestration: {
                primary: null,
                children: [],
                diagram: { href: '/api/v1/workflow-diagrams?workItemKey=wk_demo' },
              },
              execution: { runs: [], transcriptGroups: [] },
              activities: {},
              conversation: { entries: [] },
            }
          : url.endsWith('/runners')
            ? undefined
            : undefined;
    const body =
      url.endsWith('/board') || url.endsWith('/runners')
        ? {
            items: url.endsWith('/board')
              ? items.map((item) => ({
                  workItemKey: item.workItemKey,
                  workItemId: item.workItemId,
                  objective: item.objective,
                  condition: item.condition ?? 'ready',
                  externalRef: item.externalRef,
                  extendEligible: item.extendEligible,
                  dwellSince: asOf,
                  runCount: 0,
                  totalTokens: 0,
                  totalCostUsd: 0,
                  totalDurationMs: 0,
                }))
              : [],
            conditionCounts: {},
            page: { nextCursor: null, hasMore: false },
            meta: { asOf },
          }
        : { data, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function setDesktop(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches, addEventListener() {}, removeEventListener() {} }),
  });
}
