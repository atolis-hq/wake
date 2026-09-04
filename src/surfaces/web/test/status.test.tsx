import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

describe('control-plane mutation and connection state', () => {
  afterEach(() => {
    cleanup();
    window.dispatchEvent(new Event('online'));
  });

  it('does not expose a tick action or tick command feedback', async () => {
    const client = new WakeApiClient(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/control-plane/commands/tick')) {
        throw new Error('The removed tick endpoint must not be requested');
      }
      return fixtureResponse(url, init);
    });
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Tick now' })).toBeNull();
    expect(screen.queryByText('Command pending')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Pause ticks' })).toBeTruthy();
  });

  it('pauses and resumes dispatch without exposing a tick action', async () => {
    const user = userEvent.setup();
    let paused = false;
    const commands: string[] = [];
    const client = new WakeApiClient(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/control-plane/status'))
        return json({ data: { paused, updatedAt: instant }, meta: { asOf: instant } });
      if (
        url.endsWith('/control-plane/commands/pause') ||
        url.endsWith('/control-plane/commands/resume')
      ) {
        paused = url.endsWith('/pause');
        commands.push(url);
        return json({
          data: {
            commandId: `command-${commands.length}`,
            idempotencyKey: JSON.parse(String(init?.body)).idempotencyKey,
            acceptedAt: instant,
            status: 'accepted',
          },
          meta: { asOf: instant },
        });
      }
      if (url.endsWith('/control-plane/commands/tick'))
        throw new Error('The removed tick endpoint must not be requested');
      return fixtureResponse(url, init);
    });
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Pause ticks' }));
    await screen.findByRole('button', { name: 'Resume ticks' });
    await user.click(screen.getByRole('button', { name: 'Resume ticks' }));
    await screen.findByRole('button', { name: 'Pause ticks' });
    await waitFor(() =>
      expect(commands).toEqual([
        '/api/v1/control-plane/commands/pause',
        '/api/v1/control-plane/commands/resume',
      ]),
    );
    expect(screen.queryByRole('button', { name: 'Tick now' })).toBeNull();
  });

  it('shows a distinct maintenance badge when a retained lease is pausing every resident loop', async () => {
    const client = new WakeApiClient(async (input, init) =>
      String(input).endsWith('/control-plane/status')
        ? json({
            data: {
              paused: false,
              updatedAt: instant,
              maintenanceLease: {
                phase: 'failed',
                startedAt: instant,
                failure: 'active Runs remain after maintenance cancellation: run-1',
              },
            },
            meta: { asOf: instant },
          })
        : fixtureResponse(String(input), init),
    );
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Dispatch paused')).toBeTruthy();
    expect(screen.queryByText('Dispatch active')).toBeNull();
    const badge = await screen.findByText('Maintenance');
    expect(badge.parentElement?.getAttribute('title')).toBe(
      'active Runs remain after maintenance cancellation: run-1',
    );
  });

  it('presents a reconnecting banner without erasing the shell', async () => {
    const client = new WakeApiClient(async (input, init) => fixtureResponse(String(input), init));
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Pause ticks' });
    window.dispatchEvent(new Event('offline'));
    expect(await screen.findByText('Connection lost; reconnecting')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });
});

const instant = '2026-07-31T10:00:00.000Z';
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}
function fixtureResponse(url: string, _init?: RequestInit) {
  if (url.endsWith('/control-plane/status'))
    return json({ data: { paused: false, updatedAt: instant }, meta: { asOf: instant } });
  if (url.includes('/board'))
    return json({
      items: [],
      conditionCounts: {},
      page: { nextCursor: null, hasMore: false },
      meta: { asOf: instant },
    });
  return json({ data: {}, meta: { asOf: instant } });
}
