import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src-next/surfaces/cli/commands/doctor.js';

describe('doctor', () => {
  it('reports diagnostics without rebuilding derived state by default', async () => {
    let rebuilt = false;
    await expect(
      runDoctor({
        diagnose: async () => ({
          failures: ['runner unavailable'],
          notices: ['Docker unavailable'],
        }),
        projections: {
          health: async () => ({ journal: 'ok', projections: [], checkpoints: 'ok' }),
          rebuild: async () => {
            rebuilt = true;
          },
        },
      }),
    ).resolves.toEqual({
      failures: ['runner unavailable'],
      notices: ['Docker unavailable'],
      journal: 'ok',
      projections: [],
      checkpoints: 'ok',
    });
    expect(rebuilt).toBe(false);
  });

  it('rebuilds projections only after explicit operator selection', async () => {
    let rebuilt = 0;
    await runDoctor({
      rebuildProjections: true,
      diagnose: async () => ({ failures: [], notices: [] }),
      projections: {
        health: async () => ({ journal: 'ok', projections: [], checkpoints: 'ok' }),
        rebuild: async () => {
          rebuilt += 1;
        },
      },
    });
    expect(rebuilt).toBe(1);
  });
});
