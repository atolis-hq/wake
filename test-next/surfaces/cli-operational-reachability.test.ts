import { describe, expect, it } from 'vitest';
import { main } from '../../src-next/main.js';
import { parseWakeCommand, runWakeCommand } from '../../src-next/surfaces/cli/main.js';

describe('operational CLI reachability', () => {
  it.each(['init', 'doctor', 'sandbox', 'self-update', 'smoke'] as const)(
    'parses %s as a target command',
    (name) => {
      expect(parseWakeCommand([name]).kind).toBe(name);
    },
  );

  it('initialises before composing a target root', async () => {
    const calls: string[] = [];
    await main(['init', '--wake-root', '/tmp/new-wake'], {
      initialise: async (root) => calls.push(root),
      compose: async () => {
        throw new Error('init must not compose an uninitialised root');
      },
      output: { write() {} },
      signal: new AbortController().signal,
    });
    expect(calls).toEqual(['/tmp/new-wake']);
  });
  it('dispatches doctor through the injected target operational application', async () => {
    const output: string[] = [];
    await runWakeCommand(
      parseWakeCommand(['doctor']),
      {
        tick: { run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'idle' }) },
        start: { run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'idle' }) },
        stop: { stop: async () => undefined },
        api: { start: async () => undefined },
        ui: { start: async () => undefined },
        audit: { read: async () => [] },
        correlate: { correlate: async () => ({}) },
        validateState: {
          health: async () => ({ journal: 'ok', projections: 'ok', checkpoints: 'ok' }),
          rebuildProjections: async () => undefined,
        },
        operational: {
          init: async () => ({ wakeRoot: '/tmp/wake' }),
          doctor: async () => ({ failures: [], notices: ['target diagnostics'] }),
          sandbox: async () => undefined,
          selfUpdate: async () => ({ updated: false }),
          smoke: async () => ({ ok: true }),
        },
      },
      { write: (value) => output.push(value) },
      new AbortController().signal,
    );
    expect(output).toEqual(['{"failures":[],"notices":["target diagnostics"]}\n']);
  });
});
