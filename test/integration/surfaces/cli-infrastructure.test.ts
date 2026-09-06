import { describe, expect, it } from 'vitest';
import { runSandbox } from '../../../src/surfaces/cli/commands/sandbox.js';
import {
  createDockerCli,
  createLoggedDockerCli,
  createSandboxDockerPort,
} from '../../../src/surfaces/cli/infrastructure/docker-cli.js';
import { scrubProcessLog } from '../../../src/surfaces/cli/infrastructure/process-log.js';

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

  it('retains suppressed Docker output for the caller without forwarding it to the log sink', async () => {
    const entries: string[] = [];
    const docker = createLoggedDockerCli(
      {
        execute: async (_arguments, onChunk) => {
          await onChunk({ stream: 'stdout', text: 'pid=219\n' });
          await onChunk({ stream: 'stderr', text: 'sh: 1: kill: No such process\n' });
        },
      },
      {
        write: async (value) => {
          entries.push(value);
        },
        close: async () => {},
      },
    );

    const result = await docker.invoke(['exec', 'wake-sandbox'], { suppressOutput: true });

    expect(entries).toEqual([]);
    expect(result).toEqual({
      stdout: 'pid=219\n',
      stderr: 'sh: 1: kill: No such process\n',
    });
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
      [
        'build',
        '-t',
        'wake-sandbox-runtime:managed',
        '-f',
        expect.stringContaining('docker/Dockerfile.runtime.packaged'),
        '/wake-root',
      ],
      ['build', '-t', 'wake-sandbox', '-f', '/wake-root/docker/Dockerfile.packaged', '/wake-root'],
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
      [
        'exec',
        '-u',
        'root',
        'wake-sandbox',
        'sh',
        '-c',
        'mkdir -p "$1" "$2" && chown wake:wake "$1" "$2" && find "$2" -mindepth 1 -maxdepth 1 -type f -exec chown wake:wake {} +',
        'wake-sandbox-runtime-ownership',
        '/wake/workspaces',
        '/wake/.wake/auth',
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
      [
        'exec',
        '-u',
        'root',
        'configured-name',
        'sh',
        '-c',
        'mkdir -p "$1" "$2" && chown wake:wake "$1" "$2" && find "$2" -mindepth 1 -maxdepth 1 -type f -exec chown wake:wake {} +',
        'wake-sandbox-runtime-ownership',
        '/workspace/workspaces',
        '/workspace/.wake/auth',
      ],
    ]);
  });

  it('forwards the explicit runner memory profile into a newly created sandbox', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        memoryProfile: 'runner' as never,
        inspect: { imageExists: async () => true, containerState: async () => null },
      },
    );

    await docker.up();

    expect(calls[0]).toEqual(expect.arrayContaining(['-e', 'WAKE_MEMORY_PROFILE=runner']));
  });

  it('derives writable sandbox-home mount parents from configured extra mounts', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'configured-image',
        containerName: 'configured-name',
        containerHomeRoot: '/wake-root/.wake/container-home',
        containerHomeMountPath: '/home/wake',
        extraMounts: [
          { source: '/cursor-auth', target: '/home/wake/.config/cursor/auth.json', readOnly: true },
          { source: '/codex-auth', target: '/home/wake/.codex/auth.json', readOnly: true },
          { source: '/outside', target: '/other/auth.json', readOnly: true },
        ],
        inspect: { imageExists: async () => true, containerState: async () => null },
      },
    );

    await docker.up();

    expect(calls[0]).toEqual(
      expect.arrayContaining([
        '-e',
        'WAKE_HOME_INIT_ROOT=/home/wake',
        '-e',
        'WAKE_HOME_INIT_DIRS=/home/wake/.codex\n/home/wake/.config\n/home/wake/.config/cursor',
      ]),
    );
  });
  it('publishes an enabled UI port on loopback only', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        publishedPort: 4317,
        inspect: { imageExists: async () => true, containerState: async () => null },
      },
    );
    await docker.up();
    expect(calls[0]).toEqual(expect.arrayContaining(['-p', '127.0.0.1:4317:4317']));
  });
  it('repairs workspace ownership without creating a second container when the sandbox is already running', async () => {
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
    expect(calls).toEqual([
      [
        'exec',
        '-u',
        'root',
        'wake-sandbox',
        'sh',
        '-c',
        'mkdir -p "$1" "$2" && chown wake:wake "$1" "$2" && find "$2" -mindepth 1 -maxdepth 1 -type f -exec chown wake:wake {} +',
        'wake-sandbox-runtime-ownership',
        '/wake/workspaces',
        '/wake/.wake/auth',
      ],
    ]);
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
    expect(calls).toEqual([
      ['start', 'wake-sandbox'],
      [
        'exec',
        '-u',
        'root',
        'wake-sandbox',
        'sh',
        '-c',
        'mkdir -p "$1" "$2" && chown wake:wake "$1" "$2" && find "$2" -mindepth 1 -maxdepth 1 -type f -exec chown wake:wake {} +',
        'wake-sandbox-runtime-ownership',
        '/wake/workspaces',
        '/wake/.wake/auth',
      ],
    ]);
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
      ['exec', '-u', 'wake', '-it', 'wake-sandbox', 'bash'],
      ['exec', '-u', 'wake', '-i', 'wake-sandbox', 'pwd'],
    ]);
  });

  it('scrubs supported secret-shaped process output', () => {
    expect(scrubProcessLog('token=abc secret=def password=ghi key=jkl ok=value')).toBe(
      'token=[REDACTED] secret=[REDACTED] password=[REDACTED] key=[REDACTED] ok=value',
    );
  });

  it('uses an inherited terminal for the in-container sandbox setup invocation', async () => {
    const calls: { arguments_: string[]; interactive?: boolean | undefined }[] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_, options) => {
        calls.push({ arguments_: [...arguments_], interactive: options?.interactive });
      }),
      { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
    );
    await docker.setup?.();
    expect(calls).toEqual([
      {
        arguments_: [
          'exec',
          '-u',
          'wake',
          '-it',
          '-w',
          '/wake',
          'wake-sandbox',
          'sh',
          '-c',
          'if [ -n "$WAKE_MAIN_JS" ]; then node "$WAKE_MAIN_JS" sandbox-setup; else wake sandbox-setup; fi',
        ],
        interactive: true,
      },
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
        '-u',
        'wake',
        '-it',
        '-w',
        '/wake',
        'wake-sandbox',
        'sh',
        '-c',
        `cd '/wake/workspaces/o'\\''brien' && 'claude' '--resume' 'abc-123'`,
      ],
    ]);
  });

  it.each([
    ['codex', ['codex', 'exec', 'resume', 'session-7']],
    ['cursor', ['cursor', 'agent', '--resume=session-7']],
  ])(
    'preserves %s session state through the sandbox surface and Docker boundary',
    async (cli, expectedResume) => {
      const calls: string[][] = [];
      const docker = createSandboxDockerPort(
        createDockerCli(async (arguments_) => {
          calls.push([...arguments_]);
        }),
        { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
      );

      await runSandbox(['resume', 'session-7', '--cwd', '/work/item-7', '--cli', cli], docker);

      expect(calls).toEqual([
        [
          'exec',
          '-u',
          'wake',
          '-it',
          '-w',
          '/wake',
          'wake-sandbox',
          'sh',
          '-c',
          `cd '/work/item-7' && ${expectedResume.map((value) => `'${value}'`).join(' ')}`,
        ],
      ]);
    },
  );

  it('propagates a Docker exec failure through the sandbox command after recording its output', async () => {
    const entries: string[] = [];
    const docker = createSandboxDockerPort(
      createLoggedDockerCli(
        {
          execute: async (_arguments, onChunk) => {
            await onChunk({ stream: 'stderr', text: 'GITHUB_TOKEN=secret failed\\n' });
            throw new Error('docker exec exited with code 23');
          },
        },
        {
          write: async (value) => {
            entries.push(value);
          },
          close: async () => {},
        },
      ),
      { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
    );

    await expect(runSandbox(['exec', '--', 'false'], docker)).rejects.toThrow(
      'exited with code 23',
    );
    expect(entries).toEqual(['GITHUB_TOKEN=[REDACTED] failed\\n']);
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
