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
      runSmoke: async () => {
        calls.push('smoke');
      },
      runUi: async () => {
        calls.push('ui');
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
      runSmoke: async () => {
        calls.push('smoke-again');
      },
      runUi: async () => {
        calls.push('ui-again');
      },
    });

    expect(calls).toEqual(['init:/tmp/wake-home', 'sandbox:build']);
  });

  it('routes stop to the sandbox stop handler', async () => {
    const calls: string[] = [];

    await dispatchMainCommand({
      args: ['stop', '--timeout-ms', '5000'],
      runInit: async () => {
        calls.push('init');
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
      runSmoke: async () => {
        calls.push('smoke');
      },
      runUi: async () => {
        calls.push('ui');
      },
    });

    expect(calls).toEqual(['sandbox:stop --timeout-ms 5000']);
  });

  it('routes explicit smoke targets through the smoke path', async () => {
    const runSmoke = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['smoke', 'claude', '--remote-control'],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke,
      runUi: async () => {},
    });

    await dispatchMainCommand({
      args: ['smoke', 'codex', '--json'],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke,
      runUi: async () => {},
    });

    expect(runSmoke).toHaveBeenNthCalledWith(1, ['claude', '--remote-control']);
    expect(runSmoke).toHaveBeenNthCalledWith(2, ['codex', '--json']);
  });

  it('routes smoke with no explicit target through the smoke path', async () => {
    const runSmoke = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['smoke', '--wake-root', '/tmp/wake-home'],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke,
      runUi: async () => {},
    });

    expect(runSmoke).toHaveBeenCalledWith(['--wake-root', '/tmp/wake-home']);
  });

  it('routes the ui command through the ui path', async () => {
    const runUi = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['ui', '--port', '4400'],
      runInit: async () => {},
      runSandbox: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi,
    });

    expect(runUi).toHaveBeenCalledWith(['--port', '4400']);
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
        workItemKey: 'work-01JZ0000000000000000000029',
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
        workItemKey: 'work-01JZ0000000000000000000029',
        repo: 'atolis-hq/wake',
        issueNumber: 29,
        action: 'refine',
        status: 'failed',
        startedAt: '2026-07-06T12:28:12.000Z',
      }),
    ).toBeNull();
  });
});
