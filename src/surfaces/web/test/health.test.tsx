import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

describe('adapter health table', () => {
  afterEach(cleanup);

  it('renders one row per adapter health check, separate from the generic checks list', async () => {
    render(
      <MemoryRouter initialEntries={['/health']}>
        <App client={client()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'System checks' })).toBeTruthy();
    expect(screen.getByText('journal')).toBeTruthy();
    expect(screen.getByText('1 healthy')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Adapter health' }));
    const table = await screen.findByRole('table', { name: 'Adapter health' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 checks

    expect(within(table).getByText('github-issues')).toBeTruthy();
    expect(within(table).getAllByText('atolis-hq/wake')).toHaveLength(2);
    expect(within(table).getByText('poll')).toBeTruthy();
    expect(within(table).getByText('12')).toBeTruthy();

    expect(within(table).getByText('github-pull-requests')).toBeTruthy();
    expect(within(table).getByText('deliver')).toBeTruthy();
    expect(within(table).getByText('degraded')).toBeTruthy();
    expect(within(table).getByText('3 consecutive failures')).toBeTruthy();

    expect(screen.queryByText(/journal: ok/)).toBeNull();
    expect(screen.getByRole('tabpanel', { name: 'Adapter health' })).toBeTruthy();
  });

  it('switches Health sections with the keyboard and keeps refresh inside the active panel', async () => {
    render(
      <MemoryRouter initialEntries={['/health']}>
        <App client={client()} />
      </MemoryRouter>,
    );
    const overview = await screen.findByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Maintenance recovery' }));
    expect(
      within(screen.getByRole('tabpanel', { name: 'Maintenance recovery' })).getByRole('button', {
        name: 'Refresh health',
      }),
    ).toBeTruthy();
    expect(screen.getByText('No maintenance lease')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Runner availability' }));
    expect(await screen.findByText('No runners configured')).toBeTruthy();
    expect(screen.queryByText(/journal: ok/)).toBeNull();
  });

  it('offers confirmed recovery only for the failed maintenance lease the operator observed', async () => {
    const calls: unknown[] = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const asOf = '2026-07-31T10:00:00.000Z';
    const client = new WakeApiClient(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/control-plane/status'))
        return json({
          data: {
            dispatchPaused: false,
            updatedAt: asOf,
            maintenanceLease: {
              attemptId: 'attempt-1',
              phase: 'failed',
              startedAt: asOf,
              failure: 'sandbox health check failed',
            },
          },
          meta: { asOf },
        });
      if (url.endsWith('/control-plane/commands/clear-maintenance')) {
        calls.push(JSON.parse(String(init?.body)));
        return json({
          data: {
            commandId: 'control:operator-1',
            idempotencyKey: 'operator-1',
            acceptedAt: asOf,
            status: 'accepted',
          },
          meta: { asOf },
        });
      }
      if (url.endsWith('/system/health'))
        return json({
          data: { status: 'degraded', version: '0.1.0-test', checkedAt: asOf },
          meta: { asOf },
        });
      if (url.endsWith('/runners'))
        return json({ items: [], page: { nextCursor: null, hasMore: false }, meta: { asOf } });
      return json({ data: {}, meta: { asOf } });
    });
    render(
      <MemoryRouter initialEntries={['/health']}>
        <App client={client} />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('tab', { name: 'Maintenance recovery' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear failed maintenance' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ attemptId: 'attempt-1' });
    expect(window.confirm).toHaveBeenCalledWith(
      'Clear this failed maintenance lease? This immediately resumes intake and dispatch. Confirm the update attempt is abandoned.',
    );
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function client() {
  const asOf = '2026-07-31T10:00:00.000Z';
  return new WakeApiClient(async (input) => {
    const url = String(input);
    const body = url.endsWith('/system/health')
      ? {
          data: {
            status: 'degraded',
            version: '0.1.0-test',
            checkedAt: asOf,
            checks: [{ name: 'journal', status: 'ok' }],
            adapters: [
              {
                adapter: 'github-issues',
                provider: 'github',
                scope: 'atolis-hq/wake',
                channel: 'poll',
                status: 'ok',
                successCount: 12,
                failureCount: 0,
              },
              {
                adapter: 'github-pull-requests',
                provider: 'github',
                scope: 'atolis-hq/wake',
                channel: 'deliver',
                status: 'degraded',
                detail: '3 consecutive failures',
                successCount: 4,
                failureCount: 3,
              },
            ],
          },
          meta: { asOf },
        }
      : url.endsWith('/runners')
        ? { items: [], page: { nextCursor: null, hasMore: false }, meta: { asOf } }
        : url.endsWith('/control-plane/status')
          ? { data: { dispatchPaused: false, updatedAt: asOf }, meta: { asOf } }
          : { data: {}, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}
