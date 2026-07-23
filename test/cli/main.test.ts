import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CliUsageError,
  dispatchMainCommand,
  formatTickFailureDetails,
  printUsage,
  readFlagBeforeCommandTerminator,
} from '../../src/main.js';

async function makeTempWakeRootWithDockerfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wake-main-test-'));
  await mkdir(join(dir, 'docker'), { recursive: true });
  await writeFile(join(dir, 'docker', 'Dockerfile'), 'FROM node:20-slim\n', 'utf8');
  return dir;
}

async function makeTempWakeRootWithoutDockerfile(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'wake-main-test-'));
}

describe('main command routing', () => {
  it('prints the embedded version for --version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dispatchMainCommand({
      args: ['--version'],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox: async () => {},
      runDoctor: async () => {},
    });

    expect(log).toHaveBeenCalledWith('0.1.0-dev');
    log.mockRestore();
  });

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
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
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
      runCorrelate: async () => {
        calls.push('correlate');
      },
      execIntoSandbox: async () => {
        calls.push('exec-into-sandbox');
      },
      runDoctor: async () => {},
    });

    await dispatchMainCommand({
      args: ['sandbox', 'build'],
      runInit: async () => {
        calls.push('init-again');
      },
      runSandbox: async (args) => {
        calls.push(`sandbox:${args.join(' ')}`);
      },
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
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
      runCorrelate: async () => {
        calls.push('correlate-again');
      },
      execIntoSandbox: async () => {
        calls.push('exec-into-sandbox-again');
      },
      runDoctor: async () => {},
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
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
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
      runCorrelate: async () => {
        calls.push('correlate');
      },
      execIntoSandbox: async () => {
        calls.push('exec-into-sandbox');
      },
      runDoctor: async () => {},
    });

    expect(calls).toEqual(['sandbox:stop --timeout-ms 5000']);
  });

  it('routes explicit smoke targets through the smoke path', async () => {
    const wakeRoot = await makeTempWakeRootWithoutDockerfile();
    const runSmoke = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['smoke', 'claude', '--remote-control', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke,
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox: async () => {},
      runDoctor: async () => {},
    });

    await dispatchMainCommand({
      args: ['smoke', 'codex', '--json', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke,
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox: async () => {},
      runDoctor: async () => {},
    });

    expect(runSmoke).toHaveBeenNthCalledWith(1, [
      'claude',
      '--remote-control',
      '--wake-root',
      wakeRoot,
    ]);
    expect(runSmoke).toHaveBeenNthCalledWith(2, ['codex', '--json', '--wake-root', wakeRoot]);
  });

  it('routes smoke with no explicit target through the smoke path', async () => {
    const runSmoke = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['smoke', '--wake-root', '/tmp/wake-home'],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke,
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox: async () => {},
      runDoctor: async () => {},
    });

    expect(runSmoke).toHaveBeenCalledWith(['--wake-root', '/tmp/wake-home']);
  });

  it('routes the ui command through the ui path', async () => {
    const wakeRoot = await makeTempWakeRootWithoutDockerfile();
    const runUi = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['ui', '--port', '4400', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi,
      runCorrelate: async () => {},
      execIntoSandbox: async () => {},
      runDoctor: async () => {},
    });

    expect(runUi).toHaveBeenCalledWith(['--port', '4400', '--wake-root', wakeRoot]);
  });

  it('routes the correlate command through the correlate path', async () => {
    const wakeRoot = await makeTempWakeRootWithoutDockerfile();
    const runCorrelate = vi.fn(async () => {});

    await dispatchMainCommand({
      args: [
        'correlate',
        'work-01JZ0000000000000000000029',
        'github:pr:456',
        '--role',
        'review',
        '--wake-root',
        wakeRoot,
      ],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate,
      execIntoSandbox: async () => {},
      runDoctor: async () => {},
    });

    expect(runCorrelate).toHaveBeenCalledWith([
      'work-01JZ0000000000000000000029',
      'github:pr:456',
      '--role',
      'review',
      '--wake-root',
      wakeRoot,
    ]);
  });

  it('routes doctor to the doctor handler', async () => {
    const runDoctor = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['doctor', '--wake-root', '/tmp/wake-home'],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox: async () => {},
      runDoctor,
    });

    expect(runDoctor).toHaveBeenCalledWith(['--wake-root', '/tmp/wake-home']);
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

describe('printUsage', () => {
  it('writes a usage summary mentioning every command and the entry point', () => {
    const chunks: string[] = [];
    const stream = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    printUsage(stream);

    const output = chunks.join('');
    expect(output).toContain('wake init');
    expect(output).toContain('wake start');
    expect(output).toContain('tick');
    expect(output).toContain('start');
    expect(output).toContain('sandbox');
    expect(output).toContain('stop');
    expect(output).toContain('smoke');
    expect(output).toContain('ui');
    expect(output).toContain('correlate');
    expect(output).toContain('version');
  });
});

describe('CliUsageError', () => {
  it('is an Error subclass carrying its message', () => {
    const error = new CliUsageError('Unknown command: bogus');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Unknown command: bogus');
  });
});

describe('help and unknown-command handling', () => {
  function noopHandlers() {
    return {
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox: async () => {},
      runDoctor: async () => {},
    };
  }

  it.each(['--help', '-h', 'help'])('prints usage for %s and calls no handler', async (flag) => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await dispatchMainCommand({ args: [flag], ...noopHandlers() });

    expect(write).toHaveBeenCalled();
    write.mockRestore();
  });

  it('prints usage for bare args (no command) and calls no handler', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({ args: [], ...noopHandlers(), runTick });

    expect(write).toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('throws CliUsageError with the offending command for an unknown command', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      dispatchMainCommand({ args: ['bogus-command'], ...noopHandlers() }),
    ).rejects.toThrow(CliUsageError);
    await expect(
      dispatchMainCommand({ args: ['bogus-command'], ...noopHandlers() }),
    ).rejects.toThrow('Unknown command: bogus-command');

    write.mockRestore();
  });
});

describe('sandbox auto-delegation', () => {
  it('auto-delegates a runtime command into the sandbox when docker/Dockerfile exists', async () => {
    const wakeRoot = await makeTempWakeRootWithDockerfile();
    const execIntoSandbox = vi.fn(async () => {});
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['tick', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick,
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
      runDoctor: async () => {},
    });

    expect(execIntoSandbox).toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
  });

  it('runs on the host when docker/Dockerfile does not exist', async () => {
    const wakeRoot = await makeTempWakeRootWithoutDockerfile();
    const execIntoSandbox = vi.fn(async () => {});
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['tick', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick,
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
      runDoctor: async () => {},
    });

    expect(runTick).toHaveBeenCalled();
    expect(execIntoSandbox).not.toHaveBeenCalled();
  });

  it('--no-sandbox bypasses auto-delegation even when docker/Dockerfile exists', async () => {
    const wakeRoot = await makeTempWakeRootWithDockerfile();
    const execIntoSandbox = vi.fn(async () => {});
    const runTick = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['tick', '--wake-root', wakeRoot, '--no-sandbox'],
      runInit: async () => {},
      runSandbox: async () => {},
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick,
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
      runDoctor: async () => {},
    });

    expect(runTick).toHaveBeenCalled();
    expect(runTick).toHaveBeenCalledWith(['--wake-root', wakeRoot]);
    expect(execIntoSandbox).not.toHaveBeenCalled();
  });

  it('does not auto-delegate init/sandbox/stop even when docker/Dockerfile exists', async () => {
    const wakeRoot = await makeTempWakeRootWithDockerfile();
    const execIntoSandbox = vi.fn(async () => {});
    const runSandbox = vi.fn(async () => {});

    await dispatchMainCommand({
      args: ['sandbox', 'build', '--wake-root', wakeRoot],
      runInit: async () => {},
      runSandbox,
      runSandboxSetup: async () => {},
      runSandboxEntrypoint: async () => {},
      runTick: async () => {},
      runStart: async () => {},
      runSmoke: async () => {},
      runUi: async () => {},
      runCorrelate: async () => {},
      execIntoSandbox,
      runDoctor: async () => {},
    });

    expect(runSandbox).toHaveBeenCalled();
    expect(execIntoSandbox).not.toHaveBeenCalled();
  });
});
