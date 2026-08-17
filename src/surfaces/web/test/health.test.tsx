import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
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

    // the existing generic checks list is untouched, outside the new table
    expect(screen.getByText(/journal: ok/)).toBeTruthy();
  });
});

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
          ? { data: { paused: false, updatedAt: asOf }, meta: { asOf } }
          : { data: {}, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}
