import { describe, expect, it } from 'vitest';
import { runSelfUpdate } from '../../src-next/surfaces/cli/commands/self-update.js';

describe('self-update', () => {
  it('does not rerun an already-applied update without force', async () => {
    let updates = 0;
    await expect(
      runSelfUpdate({
        tag: 'v1',
        readLedger: async () => 'v1',
        writeLedger: async () => {},
        update: async () => {
          updates += 1;
        },
      }),
    ).resolves.toBe(false);
    expect(updates).toBe(0);
  });
});
