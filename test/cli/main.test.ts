import { describe, expect, it, vi } from 'vitest';

import {
  dispatchMainCommand,
  formatTickFailureDetails,
  readFlagBeforeCommandTerminator,
} from '../../src/main.js';

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
      runLocks: async () => {
        calls.push('locks');
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
      runLocks: async () => {
        calls.push('locks-again');
      },
    });

    expect(calls).toEqual(['init:/tmp/wake-home', 'sandbox:build']);
  });

  it('routes locks through the public CLI surface', async () => {
    const runLocks = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['locks', 'clear', '--wake-root', '/tmp/wake-home'],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runClaudeSmoke: async () => {},
      runLocks,
    });

    expect(runLocks).toHaveBeenCalledWith(['clear', '--wake-root', '/tmp/wake-home']);
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
      runLocks: async () => {},
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

  it('formats persisted run failure details for failed ticks', () => {
    expect(
      formatTickFailureDetails({
        schemaVersion: 1,
        runId: 'run-29',
        repo: 'atolis-hq/wake',
        issueNumber: 29,
        action: 'refine',
        status: 'failed',
        startedAt: '2026-07-06T12:28:12.000Z',
        finishedAt: '2026-07-06T12:29:12.000Z',
        sentinel: 'FAILED',
        summary: 'Claude runner failed\nSandbox logs: docker logs --tail 200 wake',
        metadata: {
          exitCode: 1,
          stderr: 'Trace line 1\nTrace line 2',
        },
      }),
    ).toBe(
      [
        'Tick failure details:',
        'runId: run-29',
        'exitCode: 1',
        '',
        'Summary:',
        'Claude runner failed',
        'Sandbox logs: docker logs --tail 200 wake',
        '',
        'stderr:',
        'Trace line 1',
        'Trace line 2',
      ].join('\n'),
    );
  });

  it('returns null when a failed tick has no persisted details to show', () => {
    expect(
      formatTickFailureDetails({
        schemaVersion: 1,
        runId: 'run-29',
        repo: 'atolis-hq/wake',
        issueNumber: 29,
        action: 'refine',
        status: 'failed',
        startedAt: '2026-07-06T12:28:12.000Z',
      }),
    ).toBeNull();
  });
});
