import { describe, expect, it } from 'vitest';
import { main } from '../../../src-next/main.js';
import { parseWakeCommand } from '../../../src-next/surfaces/cli/main.js';

describe('wake surface CLI', () => {
  it('routes commands without importing stores or provider clients', () => {
    expect(parseWakeCommand(['audit', 'work-demo'])).toEqual({
      kind: 'audit',
      workItemId: 'work-demo',
    });
    expect(parseWakeCommand(['validate-state', '--rebuild-projections'])).toEqual({
      kind: 'validate-state',
      rebuildProjections: true,
    });
  });

  it('dispatches target Surface CLI applications from the target entry point', async () => {
    const calls: string[] = [];
    await main(['tick'], {
      compose: async () => ({
        tick: {
          run: async () => {
            calls.push('tick');
            return { advances: 0, runs: 0, stoppedBecause: 'idle' };
          },
        },
        start: { run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'shutdown' }) },
        stop: { stop: async () => undefined },
        api: { start: async () => undefined },
        ui: { start: async () => undefined },
        audit: { read: async () => [] },
        correlate: { correlate: async () => ({}) },
        validateState: {
          health: async () => ({ journal: 'ok', projections: 'ok', checkpoints: 'ok' }),
          rebuildProjections: async () => undefined,
        },
      }),
      output: { write: () => undefined },
      signal: new AbortController().signal,
    });
    expect(calls).toEqual(['tick']);
  });

  it('preserves UI host and Wake-root options with a positive port', () => {
    expect(parseWakeCommand(['ui', '--port', '4400', '--wake-root', 'C:\\wake'])).toEqual({
      kind: 'ui',
      port: 4400,
      wakeRoot: 'C:\\wake',
    });
    expect(() => parseWakeCommand(['ui', '--port', '0'])).toThrow(/positive/i);
    expect(() => parseWakeCommand(['ui', '--port', 'nope'])).toThrow(/positive/i);
  });
});
