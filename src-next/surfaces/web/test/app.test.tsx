import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

describe('Wake operator app', () => {
  afterEach(cleanup);
  it('redirects its clean root route to the board', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeTruthy();
  });

  it('renders a persistent semantic shell with clean route links and independent status', async () => {
    render(
      <MemoryRouter initialEntries={['/work']}>
        <App client={client()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Board' }).getAttribute('href')).toBe('/board');
    expect(screen.getByRole('heading', { name: 'Work' })).toBeTruthy();
    expect(await screen.findByText('Dispatch active')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Work items' })).toBeTruthy();
  });

  it('separates the brand band from the status band so status is not a nav item', async () => {
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    const banner = await screen.findByRole('banner');
    expect(banner.textContent).toContain('WAKE');
    expect(screen.getByRole('img', { name: 'Wake logo' }).getAttribute('src')).toMatch(
      /^data:image\/svg\+xml/,
    );
    const status = await screen.findByRole('status', { name: 'Control plane' });
    expect(status.textContent).toContain('Dispatch active');
    expect(within(banner).queryByText('Dispatch active')).toBeNull();
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

  it('uses one route-backed detail feature as a desktop modal and mobile full page', async () => {
    const background = { pathname: '/board', search: '', hash: '', state: null, key: 'board' };
    setDesktop(true);
    const desktop = render(
      <MemoryRouter initialEntries={[{ pathname: '/work/wk_demo', state: { background } }]}>
        <App client={client()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('dialog', { name: 'Work item detail' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Demo Wake' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close work detail' })).toBeTruthy();
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

function client(options: { workItems?: readonly unknown[]; failHealth?: boolean } = {}) {
  const asOf = '2026-07-31T10:00:00.000Z';
  return new WakeApiClient(async (input) => {
    const url = String(input);
    if (options.failHealth && url.endsWith('/system/health'))
      return new Response(
        JSON.stringify({ type: 'about:blank', title: 'Health unavailable', status: 500 }),
        { status: 500, headers: { 'content-type': 'application/problem+json' } },
      );
    const items = options.workItems ?? [
      {
        workItemKey: 'wk_demo',
        workItemId: 'work-demo',
        objective: 'Demo Wake',
        state: 'open',
        relatedWorkItems: [],
      },
    ];
    const data = url.endsWith('/control-plane/status')
      ? { paused: false, updatedAt: asOf }
      : url.endsWith('/system/health')
        ? { status: 'ok', checkedAt: asOf, checks: [] }
        : url.endsWith('/work-items/wk_demo')
          ? {
              work: items[0],
              resources: [],
              orchestration: { primary: null, children: [] },
              execution: { runs: [] },
              activities: {},
            }
          : url.endsWith('/runners')
            ? undefined
            : undefined;
    const body =
      url.endsWith('/work-items') || url.endsWith('/runners')
        ? {
            items: url.endsWith('/work-items') ? items : [],
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
