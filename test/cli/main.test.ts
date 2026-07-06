import { describe, expect, it, vi } from 'vitest';

import { dispatchMainCommand, readFlagBeforeCommandTerminator } from '../../src/main.js';

describe('main command routing', () => {
  it('routes init and sandbox through the public CLI surface', async () => {
    const calls: string[] = [];

    await dispatchMainCommand({
      args: ['init', '/tmp/wake-home'],
      runInit: async (args) => {
        calls.push(`init:${args.join(' ')}`);
      },
      runSandbox: async (args) => {
        calls.push(`sandbox:${args.join(' ')}`);
      },
      runTick: async () => {
        calls.push('tick');
      },
      runStart: async () => {
        calls.push('start');
      },
      runClaudeSmoke: async () => {
        calls.push('smoke');
      },
    });

    await dispatchMainCommand({
      args: ['sandbox', 'build'],
      runInit: async () => {
        calls.push('init-again');
      },
      runSandbox: async (args) => {
        calls.push(`sandbox:${args.join(' ')}`);
      },
      runTick: async () => {
        calls.push('tick-again');
      },
      runStart: async () => {
        calls.push('start-again');
      },
      runClaudeSmoke: async () => {
        calls.push('smoke-again');
      },
    });

    expect(calls).toEqual(['init:/tmp/wake-home', 'sandbox:build']);
  });

  it('still routes smoke claude through the smoke path', async () => {
    const runClaudeSmoke = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['smoke', 'claude', '--remote-control'],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runClaudeSmoke,
    });

    expect(runClaudeSmoke).toHaveBeenCalledWith(['--remote-control']);
  });

  it('ignores inner exec payload flags after command terminator', () => {
    expect(
      readFlagBeforeCommandTerminator('--wake-root', [
        'exec',
        '--',
        'node',
        '/app/dist/src/main.js',
        'tick',
        '--wake-root',
        '/wake',
      ]),
    ).toBeUndefined();

    expect(
      readFlagBeforeCommandTerminator('--wake-root', [
        'exec',
        '--wake-root',
        'C:\\Users\\live\\wake-home',
        '--',
        'node',
        '/app/dist/src/main.js',
        'tick',
        '--wake-root',
        '/wake',
      ]),
    ).toBe('C:\\Users\\live\\wake-home');
  });
});
