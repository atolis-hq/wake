import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app/app.js';
import { WakeApiClient } from '../src/api/client.js';

const asOf = '2026-07-31T10:00:00.000Z';

function runsClient(available: boolean) {
  const run = {
    runId: 'run-1',
    activationId: 'activation-1',
    activity: 'agent',
    workflowInstanceId: 'workflow-1',
    orchestrationGroupId: 'group-1',
    attempt: 1,
    status: 'succeeded',
    active: false,
    startedAt: asOf,
    finishedAt: asOf,
  };
  return new WakeApiClient(async (input) => {
    const url = String(input);
    const body = url.includes('/transcript')
      ? {
          data: {
            runId: 'run-1',
            available,
            entries: available
              ? [
                  { occurredAt: asOf, channel: 'prompt', text: 'Investigate the failure' },
                  { occurredAt: asOf, channel: 'result', text: 'wake-result DONE' },
                ]
              : [],
          },
          meta: { asOf },
        }
      : url.includes('/runs/run-1')
        ? { data: run, meta: { asOf } }
        : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('run detail', () => {
  afterEach(cleanup);

  it('renders transcript entries as structured records, not raw JSON', async () => {
    render(
      <MemoryRouter initialEntries={['/runs/run-1']}>
        <App client={runsClient(true)} />
      </MemoryRouter>,
    );
    const transcript = await screen.findByRole('list', { name: 'Transcript' });
    expect(transcript.textContent).toContain('prompt');
    expect(transcript.textContent).toContain('Investigate the failure');
    expect(transcript.textContent).toContain('wake-result DONE');
    expect(screen.queryByText('Structured details')).toBeNull();
  });

  it('states plainly when a transcript is unavailable', async () => {
    render(
      <MemoryRouter initialEntries={['/runs/run-1']}>
        <App client={runsClient(false)} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Transcript unavailable')).toBeTruthy();
  });
});
