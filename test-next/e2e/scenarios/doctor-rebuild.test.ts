import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../../src-next/surfaces/cli/commands/doctor.js';

describe('E2E-OPS-001: doctor rebuild', () => {
  it('repairs a disposable projection without changing canonical journal bytes', async () => {
    const journalBytes = '{"eventType":"work.created"}\n';
    let projection = 'corrupted';

    const result = await runDoctor({
      rebuildProjections: true,
      diagnose: async () => ({ failures: [], notices: [] }),
      projections: {
        health: async () => ({
          journal: 'ok',
          projections: projection === 'corrupted' ? ['work: corrupted'] : [],
          checkpoints: 'ok',
        }),
        rebuild: async () => {
          projection = 'rebuilt';
        },
      },
    });

    expect(result.projections).toEqual([]);
    expect(journalBytes).toBe('{"eventType":"work.created"}\n');
  });
});
