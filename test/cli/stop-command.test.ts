import { describe, expect, it, vi } from 'vitest';

import { runStopCommand, waitForActiveRuns } from '../../src/cli/stop-command.js';
import type { RunRecord } from '../../src/domain/types.js';

function makeRunRecord(status: RunRecord['status']): RunRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    repo: 'atolis-hq/wake',
    issueNumber: 1,
    action: 'implement',
    status,
    startedAt: '2026-07-11T00:00:00.000Z',
  } as RunRecord;
}

describe('waitForActiveRuns', () => {
  it('returns immediately when no run is active', async () => {
    const sleep = vi.fn(async () => {});
    const listRunRecords = vi.fn(async () => [makeRunRecord('completed')]);

    await waitForActiveRuns({
      listRunRecords,
      sleep,
      logger: { info: () => {} },
    });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until the active run finishes', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const listRunRecords = vi.fn(async () => {
      calls += 1;
      return [makeRunRecord(calls < 3 ? 'running' : 'completed')];
    });

    await waitForActiveRuns({
      listRunRecords,
      sleep,
      pollIntervalMs: 10,
      logger: { info: () => {} },
    });

    expect(listRunRecords).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('throws if the timeout elapses while a run is still active', async () => {
    const sleep = vi.fn(async () => {});
    const listRunRecords = vi.fn(async () => [makeRunRecord('running')]);

    await expect(
      waitForActiveRuns({
        listRunRecords,
        sleep,
        pollIntervalMs: 10,
        timeoutMs: 25,
        logger: { info: () => {} },
      }),
    ).rejects.toThrow('Timed out after 25ms waiting for active runs to finish');
  });
});

describe('runStopCommand', () => {
  it('waits for active runs then stops the container with a grace period', async () => {
    const down = vi.fn(async () => {});
    let calls = 0;
    const listRunRecords = vi.fn(async () => {
      calls += 1;
      return [makeRunRecord(calls < 2 ? 'running' : 'completed')];
    });

    await runStopCommand({
      args: [],
      stateStore: { listRunRecords },
      docker: { down },
      containerName: 'wake-sandbox',
      sleep: vi.fn(async () => {}),
      logger: { info: () => {} },
    });

    expect(down).toHaveBeenCalledWith('wake-sandbox', { timeoutSeconds: 60 });
  });

  it('honors a --timeout-ms override', async () => {
    const down = vi.fn(async () => {});
    const listRunRecords = vi.fn(async () => [makeRunRecord('running')]);

    await expect(
      runStopCommand({
        args: ['--timeout-ms', '20'],
        stateStore: { listRunRecords },
        docker: { down },
        containerName: 'wake-sandbox',
        sleep: vi.fn(async () => {}),
        logger: { info: () => {} },
      }),
    ).rejects.toThrow('Timed out after 20ms waiting for active runs to finish');
    expect(down).not.toHaveBeenCalled();
  });
});
