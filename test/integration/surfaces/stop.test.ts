import { describe, expect, it } from 'vitest';
import { waitForActiveRuns } from '../../../src/surfaces/cli/commands/stop.js';

describe('target stop', () => {
  it('waits until projected active runs have finished before stopping the host', async () => {
    let checks = 0;
    const waits: number[] = [];
    await waitForActiveRuns({
      activeRunIds: async () => (++checks === 1 ? ['run-1'] : []),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      pollIntervalMs: 7,
    });
    expect(waits).toEqual([7]);
  });
});
