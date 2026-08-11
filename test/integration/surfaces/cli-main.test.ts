import { describe, expect, it } from 'vitest';
import { main } from '../../../src/main.js';
import { parseWakeCommand } from '../../../src/surfaces/cli/main.js';

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

  it('executes runtime commands in an available sandbox with the container wake root', async () => {
    const calls: string[][] = [];
    await main(['start', '--wake-root', 'C:\\wake-home'], {
      compose: async () => ({
        ...fixtureApplications(),
        sandboxRuntime: {
          hasDockerfile: async () => true,
          exec: async (arguments_) => {
            calls.push([...arguments_]);
          },
        },
      }),
      output: { write: () => undefined },
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([['start', '--wake-root', '/wake', '--no-sandbox']]);
  });

  it('delegates runtime commands before composing host integrations', async () => {
    const calls: string[] = [];
    await main(['tick', '--wake-root', 'C:\\wake-home'], {
      compose: async () => {
        throw new Error('host integrations must not compose');
      },
      sandboxRuntime: {
        hasDockerfile: async (wakeRoot) => {
          calls.push(wakeRoot);
          return true;
        },
        exec: async (_wakeRoot, arguments_) => {
          calls.push(arguments_.join(' '));
        },
      },
      output: { write: () => undefined },
      signal: new AbortController().signal,
    });
    expect(calls).toEqual(['C:\\wake-home', 'tick --wake-root /wake --no-sandbox']);
  });

  it('keeps runtime commands on the host when --no-sandbox is supplied', async () => {
    const calls: string[] = [];
    await main(['tick', '--no-sandbox'], {
      compose: async () => ({
        ...fixtureApplications(calls),
        sandboxRuntime: {
          hasDockerfile: async () => true,
          exec: async () => {
            calls.push('sandbox');
          },
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

function fixtureApplications(calls: string[] = []) {
  return {
    tick: {
      run: async () => {
        calls.push('tick');
        return { advances: 0, runs: 0, stoppedBecause: 'idle' as const };
      },
    },
    start: {
      run: async () => ({ advances: 0, runs: 0, stoppedBecause: 'shutdown' as const }),
    },
    stop: { stop: async () => undefined },
    api: { start: async () => undefined },
    ui: { start: async () => undefined },
    audit: { read: async () => [] },
    correlate: { correlate: async () => ({}) },
    validateState: {
      health: async () => ({ journal: 'ok', projections: 'ok', checkpoints: 'ok' }),
      rebuildProjections: async () => undefined,
    },
  };
}
