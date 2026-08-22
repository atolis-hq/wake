import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

describe('configuration page commands tab', () => {
  afterEach(cleanup);

  it('shows the effective configuration by default', async () => {
    render(
      <MemoryRouter initialEntries={['/configuration']}>
        <App client={client()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Read-only effective configuration/)).toBeTruthy();
  });

  it('shows workflow examples only on the workflows tab', async () => {
    render(
      <MemoryRouter initialEntries={['/configuration']}>
        <App client={client()} />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('Workflow Dark Factory - configuration')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Workflows' }));

    const standard = await screen.findByLabelText('Workflow Dark Factory - configuration');
    const instance = screen.getByLabelText('Workflow Dark Factory - work-item run');
    expect(screen.getByRole('heading', { name: 'Configuration workflow definition' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Work-item workflow instance' })).toBeTruthy();
    expect(standard).toBeTruthy();
    expect(instance).toBeTruthy();
  });

  it('shows workflow examples without waiting for the configuration read', async () => {
    render(
      <MemoryRouter initialEntries={['/configuration']}>
        <App client={loadingClient()} />
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Workflows' }));

    expect(await screen.findByLabelText('Workflow Dark Factory - configuration')).toBeTruthy();
    expect(screen.getByLabelText('Workflow Dark Factory - work-item run')).toBeTruthy();
    expect(screen.queryByText('Loading redacted configuration')).toBeNull();
  });

  it('lists built-in and configured commands per adapter on the commands tab', async () => {
    render(
      <MemoryRouter initialEntries={['/configuration']}>
        <App client={client()} />
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Commands' }));

    const panel = await screen.findByRole('tabpanel', { name: 'Commands' });
    expect(within(panel).getByText('github')).toBeTruthy();
    expect(within(panel).getByText('/approved')).toBeTruthy();
    expect(within(panel).getByText('/accepted')).toBeTruthy();
    expect(within(panel).getByText('/changes')).toBeTruthy();
    expect(within(panel).getByText('/retry')).toBeTruthy();
    expect(within(panel).getByText('/deploy')).toBeTruthy();
  });
});

function client() {
  const asOf = '2026-08-18T10:00:00.000Z';
  return new WakeApiClient(async (input) => {
    const url = String(input);
    const body = url.endsWith('/system/configuration')
      ? { data: { configuration: {} }, meta: { asOf } }
      : url.endsWith('/system/commands')
        ? {
            data: {
              adapters: [
                {
                  adapter: 'github',
                  provider: 'github',
                  commands: [
                    { syntax: '/approved' },
                    { syntax: '/accepted' },
                    { syntax: '/changes' },
                    { syntax: '/retry' },
                    { syntax: '/deploy' },
                  ],
                },
              ],
            },
            meta: { asOf },
          }
        : { data: {}, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function loadingClient() {
  return new WakeApiClient(async (input) => {
    if (String(input).endsWith('/system/configuration')) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ data: {}, meta: { asOf: '2026-08-18T10:00:00.000Z' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}
