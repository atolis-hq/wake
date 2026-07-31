import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { App } from '../src/app/app.js';
import { WakeApiClient } from '../src/api/client.js';

describe('control-plane mutation and connection state', () => {
  afterEach(() => {
    cleanup();
    window.dispatchEvent(new Event('online'));
  });

  it('suppresses duplicate advances, applies confirmed status, and invalidates related queries', async () => {
    const user = userEvent.setup();
    let advances = 0;
    const idempotencyKeys: string[] = [];
    let statusReads = 0;
    let workReads = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new WakeApiClient(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/control-plane/commands/advance')) {
        advances += 1;
        const request = JSON.parse(String(init?.body)) as { idempotencyKey: string };
        idempotencyKeys.push(request.idempotencyKey);
        await pending;
        return json(
          {
            data: {
              commandId: 'advance-1',
              idempotencyKey: request.idempotencyKey,
              acceptedAt: instant,
              status: 'accepted',
              result: {
                data: { paused: true, updatedAt: instant, reason: 'Advanced 1 item' },
                meta: { asOf: instant, position: 42 },
              },
            },
            meta: { asOf: instant },
          },
          202,
        );
      }
      if (url.endsWith('/control-plane/status')) {
        statusReads += 1;
        return json({
          data: { paused: false, updatedAt: instant },
          meta: { asOf: instant },
        });
      }
      if (url.includes('/work-items')) workReads += 1;
      return fixtureResponse(url, init);
    });
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );
    const advance = await screen.findByRole('button', { name: 'Advance' });
    await screen.findByText('No work items');
    const initialWorkReads = workReads;
    await user.click(advance);
    expect(screen.getByText(/Command pending/)).toBeTruthy();
    expect(advance.hasAttribute('disabled')).toBe(true);
    await user.click(advance);
    expect(advances).toBe(1);
    release();
    expect(await screen.findByText('Dispatch paused')).toBeTruthy();
    await waitFor(() => expect(workReads).toBeGreaterThan(initialWorkReads));
    expect(statusReads).toBe(1);
    await waitFor(() => expect(advance.hasAttribute('disabled')).toBe(false));
    await user.click(advance);
    await waitFor(() => expect(advances).toBe(2));
    expect(idempotencyKeys[0]).toMatch(/^web:advance:/);
    expect(idempotencyKeys[1]).toMatch(/^web:advance:/);
    expect(idempotencyKeys[1]).not.toBe(idempotencyKeys[0]);
  });

  it('presents Problem conflict state and a reconnecting banner without erasing the shell', async () => {
    const user = userEvent.setup();
    const client = new WakeApiClient(async (input, init) =>
      String(input).endsWith('/control-plane/commands/advance')
        ? json(
            {
              type: 'https://wake.atolis.dev/problems/conflict',
              title: 'Advance conflict',
              status: 409,
              code: 'current-state',
              current: { paused: true },
            },
            409,
          )
        : fixtureResponse(String(input), init),
    );
    render(
      <MemoryRouter initialEntries={['/board']}>
        <App client={client} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Advance' }));
    expect(await screen.findByText('Conflict: Advance conflict')).toBeTruthy();
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
  if (url.includes('/work-items'))
    return json({ items: [], page: { nextCursor: null, hasMore: false }, meta: { asOf: instant } });
  return json({ data: {}, meta: { asOf: instant } });
}
