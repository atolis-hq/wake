import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WakeApiClient } from '../src/api/client.js';
import { App } from '../src/app/app.js';

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
    sentinel: 'DONE',
    totalTokens: 0,
    totalCostUsd: 0,
  };
  return new WakeApiClient(async (input) => {
    const url = String(input);
    const body = url.includes('/transcript')
      ? {
          data: {
            runId: 'run-1',
            groupId: 'run--run-1',
            available,
            entries: available
              ? [
                  {
                    occurredAt: asOf,
                    channel: 'input',
                    text: 'Investigate the failure',
                    runId: 'run-1',
                    groupId: 'run--run-1',
                  },
                  {
                    occurredAt: asOf,
                    channel: 'agent',
                    text: 'wake-result DONE',
                    runId: 'run-1',
                    groupId: 'run--run-1',
                  },
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

function activeRunsClient() {
  const starting = {
    runId: 'run-starting',
    activationId: 'activation-starting',
    activity: 'prepare',
    workflowInstanceId: 'workflow-starting',
    orchestrationGroupId: 'group-starting',
    attempt: 1,
    status: 'starting',
    active: true,
    startedAt: '2026-07-31T09:58:00.000Z',
    sentinel: 'STARTING',
    runnerName: 'codex',
    workflowName: 'delivery',
    stage: 'implement',
    totalTokens: 0,
    totalCostUsd: 0,
  };
  const running = {
    ...starting,
    runId: 'run-running',
    status: 'started',
    sentinel: 'STARTED',
    executionStartedAt: '2026-07-31T09:59:00.000Z',
  };
  return new WakeApiClient(async (input) => {
    const url = String(input);
    const body = url.endsWith('/runs')
      ? {
          items: [starting, running],
          page: { nextCursor: null, hasMore: false },
          meta: { asOf },
        }
      : url.includes('/runs/run-starting')
        ? { data: starting, meta: { asOf } }
        : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('run detail', () => {
  afterEach(cleanup);

  it('shows Starting and Running labels immediately and elapsed preparation duration', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-31T10:00:00.000Z').getTime());
    try {
      const client = activeRunsClient();
      const { unmount } = render(
        <MemoryRouter initialEntries={['/runs']}>
          <App client={client} />
        </MemoryRouter>,
      );
      expect(await screen.findByText('Starting')).toBeTruthy();
      expect(screen.getByText('Running')).toBeTruthy();
      const startingRow = screen.getByRole('link', { name: 'run-starting' }).closest('tr');
      if (startingRow === null) throw new Error('Expected the starting run row');
      expect(within(startingRow).getByText('2m')).toBeTruthy();
      unmount();

      render(
        <MemoryRouter initialEntries={['/runs/run-starting']}>
          <App client={client} />
        </MemoryRouter>,
      );
      expect(await screen.findByText('Starting')).toBeTruthy();
    } finally {
      now.mockRestore();
    }
  });

  it('renders transcript entries as structured records, not raw JSON', async () => {
    render(
      <MemoryRouter initialEntries={['/runs/run-1']}>
        <App client={runsClient(true)} />
      </MemoryRouter>,
    );
    const transcript = await screen.findByRole('list', { name: 'Transcript' });
    expect(transcript.textContent).toContain('input');
    expect(transcript.textContent).toContain('agent');
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
