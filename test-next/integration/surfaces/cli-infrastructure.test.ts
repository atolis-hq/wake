import { describe, expect, it } from 'vitest';
import {
  createDockerCli,
  createLoggedDockerCli,
  createSandboxDockerPort,
} from '../../../src-next/surfaces/cli/infrastructure/docker-cli.js';
import { scrubProcessLog } from '../../../src-next/surfaces/cli/infrastructure/process-log.js';

// eslint-disable-next-line max-lines-per-function -- scenario coverage shares one injected CLI boundary.
describe('CLI infrastructure', () => {
  it('delegates Docker invocation through its injected process boundary', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli(async (arguments_) => {
      calls.push([...arguments_]);
    });

    await docker.invoke(['ps']);

    expect(calls).toEqual([['ps']]);
  });

  it('persists scrubbed Docker output through an injected target log sink', async () => {
    const entries: string[] = [];
    const docker = createLoggedDockerCli(
      {
        execute: async (_arguments, onChunk) => {
          await onChunk({ stream: 'stdout', text: 'token=secret\n' });
          await onChunk({ stream: 'stderr', text: 'warning\n' });
        },
      },
      {
        write: async (value) => {
          entries.push(value);
        },
        close: async () => {},
      },
    );
    await docker.invoke(['logs', 'wake-sandbox']);
    expect(entries).toEqual(['token=[REDACTED]\n', 'warning\n']);
  });

  it('writes each chunk to the log sink as it arrives, not batched at process exit', async () => {
    const writeOrder: string[] = [];
    const writtenBeforeSecondChunkArrives: string[] = [];
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });

    const docker = createLoggedDockerCli(
      {
        execute: async (_arguments, onChunk) => {
          await onChunk({ stream: 'stdout', text: 'chunk-1\n' });
          // Only resolves once the test has observed chunk-1 was already
          // written, proving delivery is incremental rather than buffered
          // until this execute() call returns.
          await secondChunkGate;
          await onChunk({ stream: 'stdout', text: 'chunk-2\n' });
        },
      },
      {
        write: async (value) => {
          writeOrder.push(value);
        },
        close: async () => {},
      },
    );

    const invocation = docker.invoke(['build']);
    await Promise.resolve();
    await Promise.resolve();
    writtenBeforeSecondChunkArrives.push(...writeOrder);
    releaseSecondChunk();
    await invocation;

    expect(writtenBeforeSecondChunkArrives).toEqual(['chunk-1\n']);
    expect(writeOrder).toEqual(['chunk-1\n', 'chunk-2\n']);
  });

  it('rejects when the Docker process exits non-zero, after streaming its output', async () => {
    const entries: string[] = [];
    const docker = createLoggedDockerCli(
      {
        execute: async (_arguments, onChunk) => {
          await onChunk({ stream: 'stderr', text: 'boom\n' });
          throw new Error('docker build exited with code 1: boom');
        },
      },
      {
        write: async (value) => {
          entries.push(value);
        },
        close: async () => {},
      },
    );
    await expect(docker.invoke(['build'])).rejects.toThrow('exited with code 1');
    expect(entries).toEqual(['boom\n']);
  });

  it('maps target sandbox lifecycle calls to bounded Docker arguments', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        inspect: { imageExists: async () => true, containerState: async () => null },
      },
    );
    await docker.build();
    await docker.up();
    await docker.down();
    expect(calls).toEqual([
      ['build', '-t', 'wake-sandbox', '-f', '/wake-root/docker/Dockerfile', '/wake-root'],
      [
        'run',
        '-d',
        '--log-opt',
        'max-size=10m',
        '--log-opt',
        'max-file=3',
        '--name',
        'wake-sandbox',
        '-v',
        '/wake-root:/wake',
        'wake-sandbox',
      ],
      ['stop', '--time', '60', 'wake-sandbox'],
    ]);
  });

  it('bounds the container-side json-file log driver on every created container', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        inspect: { imageExists: async () => true, containerState: async () => null },
      },
    );
    await docker.up();
    const [runArguments] = calls;
    expect(runArguments).toEqual(expect.arrayContaining(['--log-opt', 'max-size=10m']));
    expect(runArguments).toEqual(expect.arrayContaining(['--log-opt', 'max-file=3']));
  });

  it('maps configured host mounts and resident mode to the Docker boundary', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        containerHomeRoot: '/wake-root/.wake/container-home',
        image: 'configured-image',
        containerName: 'configured-name',
        wakeMountPath: '/workspace',
        containerHomeMountPath: '/home/runner',
        extraMounts: [{ source: '/repos', target: '/repos', readOnly: true }],
        startEnabled: true,
        inspect: { imageExists: async () => true, containerState: async () => null },
      },
    );
    await docker.up();
    expect(calls).toEqual([
      [
        'run',
        '-d',
        '--log-opt',
        'max-size=10m',
        '--log-opt',
        'max-file=3',
        '--name',
        'configured-name',
        '-v',
        '/wake-root:/workspace',
        '-v',
        '/wake-root/.wake/container-home:/home/runner',
        '-v',
        '/repos:/repos:ro',
        '-e',
        'WAKE_START_ENABLED=true',
        'configured-image',
      ],
    ]);
  });
  it('does not create a second container when the sandbox is already running', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        inspect: { imageExists: async () => true, containerState: async () => 'live' },
      },
    );
    await docker.up();
    expect(calls).toEqual([]);
  });

  it('starts an existing stopped sandbox rather than recreating it', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        inspect: { imageExists: async () => true, containerState: async () => 'halted' },
      },
    );
    await docker.up();
    expect(calls).toEqual([['start', 'wake-sandbox']]);
  });

  it('requires an image before starting the sandbox', async () => {
    const docker = createSandboxDockerPort(
      createDockerCli(async () => undefined),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        inspect: { imageExists: async () => false, containerState: async () => null },
      },
    );
    await expect(docker.up()).rejects.toThrow('Sandbox image not found');
  });

  it('uses a terminal shell only for an interactive target sandbox exec', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
    );
    await docker.exec([]);
    await docker.exec(['pwd']);
    expect(calls).toEqual([
      ['exec', '-it', 'wake-sandbox', 'bash'],
      ['exec', '-i', 'wake-sandbox', 'pwd'],
    ]);
  });

  it('scrubs supported secret-shaped process output', () => {
    expect(scrubProcessLog('token=abc secret=def password=ghi key=jkl ok=value')).toBe(
      'token=[REDACTED] secret=[REDACTED] password=[REDACTED] key=[REDACTED] ok=value',
    );
  });

  it('resolves the in-container wake invocation from WAKE_MAIN_JS for sandbox setup', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
    );
    await docker.setup?.();
    expect(calls).toEqual([
      [
        'exec',
        '-it',
        'wake-sandbox',
        'sh',
        '-c',
        'if [ -n "$WAKE_MAIN_JS" ]; then node "$WAKE_MAIN_JS" sandbox-setup; else wake sandbox-setup; fi',
      ],
    ]);
  });

  it('shell-wraps a cwd-scoped resume command for the selected agent CLI', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
    );
    await docker.resume?.({ sessionId: 'abc-123', cwd: "/wake/workspaces/o'brien", cli: 'claude' });
    expect(calls).toEqual([
      [
        'exec',
        '-it',
        'wake-sandbox',
        'sh',
        '-c',
        `cd '/wake/workspaces/o'\\''brien' && 'claude' '--resume' 'abc-123'`,
      ],
    ]);
  });

  it('rejects a resume request for an unsupported agent CLI', async () => {
    const docker = createSandboxDockerPort(
      createDockerCli(async () => undefined),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
      },
    );
    await expect(
      docker.resume?.({ sessionId: 'abc-123', cwd: '/workspace', cli: 'unknown-cli' }),
    ).rejects.toThrow('does not support CLI');
  });
});
