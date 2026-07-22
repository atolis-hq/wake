import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createDockerCli, type DockerExecProcess } from '../../src/adapters/docker/docker-cli.js';

function createFakeExecProcess(): {
  process: DockerExecProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  emitClose: (exitCode: number | null) => void;
  emitError: (error: Error) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  return {
    process: {
      stdout,
      stderr,
      on: (event, listener) => {
        emitter.on(event, listener);
      },
    } as DockerExecProcess,
    stdout,
    stderr,
    emitClose: (exitCode) => emitter.emit('close', exitCode),
    emitError: (error) => emitter.emit('error', error),
  };
}

describe('docker cli adapter', () => {
  it('builds docker images with the expected arguments', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.build({
      image: 'wake-sandbox',
      dockerfile: 'docker/Dockerfile',
      contextDir: '/repo/wake',
    });

    expect(calls).toEqual([
      ['build', '-t', 'wake-sandbox', '-f', 'docker/Dockerfile', '/repo/wake'],
    ]);
  });

  it('passes build args as --build-arg flags before the context dir', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.build({
      image: 'wake-sandbox',
      dockerfile: 'docker/Dockerfile',
      contextDir: '/repo/wake',
      buildArgs: { WAKE_VERSION: '1.2.3' },
    });

    expect(calls).toEqual([
      [
        'build',
        '-t',
        'wake-sandbox',
        '-f',
        'docker/Dockerfile',
        '--build-arg',
        'WAKE_VERSION=1.2.3',
        '/repo/wake',
      ],
    ]);
  });

  it('runs a new container with the expected mounts when none exists', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
    });

    expect(calls).toEqual([
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        'wake-sandbox',
      ],
    ]);
  });

  it('fails fast when the sandbox image is missing', async () => {
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async () => {
        throw new Error('should not run');
      },
    });

    await expect(
      docker.up({
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        wakeRoot: '/host/wake-home',
        containerHomeRoot: '/host/wake-home/container-home',
        containerMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
      }),
    ).rejects.toThrow('Sandbox image not found. Run `wake sandbox build` first.');
  });

  it('starts an existing stopped container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => 'stopped',
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
    });

    expect(calls).toEqual([['start', 'wake-sandbox']]);
  });

  it('does nothing when the container is already running', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => 'running',
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
    });

    expect(calls).toEqual([]);
  });

  it('replaces an existing running container without changing mounted paths', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => 'running',
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.update({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
    });

    expect(calls).toEqual([
      ['stop', 'wake-sandbox'],
      ['rm', 'wake-sandbox'],
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        'wake-sandbox',
      ],
    ]);
  });

  it('creates the container during update when none exists', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.update({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
    });

    expect(calls).toEqual([
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        'wake-sandbox',
      ],
    ]);
  });

  it('mounts configured extra host paths when creating a new container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      extraMounts: [
        {
          source: '/host/.claude/skills',
          target: '/home/wake/.claude/skills',
          readOnly: true,
        },
      ],
    });

    expect(calls).toEqual([
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        '-v',
        '/host/.claude/skills:/home/wake/.claude/skills:ro',
        'wake-sandbox',
      ],
    ]);
  });

  it('publishes the UI port and forwards its env vars only when ui.enabled', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      ui: { enabled: true, port: 4317, token: 'secret-token' },
    });

    expect(calls).toEqual([
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        '-p',
        '127.0.0.1:4317:4317',
        '-e',
        'WAKE_UI_ENABLED=true',
        '-e',
        'WAKE_UI_PORT=4317',
        '-e',
        'WAKE_UI_TOKEN=secret-token',
        'wake-sandbox',
      ],
    ]);
  });

  it('forwards ngrok tunnel env only when ui tunnel is enabled', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      ui: {
        enabled: true,
        port: 4317,
        tunnel: { enabled: true, authToken: 'ngrok-token' },
      },
    });

    expect(calls[0]).toContain('WAKE_UI_TUNNEL_ENABLED=true');
    expect(calls[0]).toContain('NGROK_AUTHTOKEN=ngrok-token');
  });

  it('passes through host ngrok auth env when tunnel is enabled without a config token', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      ui: {
        enabled: true,
        port: 4317,
        tunnel: { enabled: true },
      },
    });

    expect(calls[0]).toContain('WAKE_UI_TUNNEL_ENABLED=true');
    expect(calls[0]).toContain('NGROK_AUTHTOKEN');
    expect(calls[0]).not.toContain('NGROK_AUTHTOKEN=ngrok-token');
  });

  it('omits the UI port mapping when ui.enabled is false', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      ui: { enabled: false, port: 4317 },
    });

    expect(calls).toEqual([
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        'wake-sandbox',
      ],
    ]);
  });

  it('passes resident start env when start.enabled is true', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.up({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      start: { enabled: true },
    });

    expect(calls).toEqual([
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        '-e',
        'WAKE_START_ENABLED=true',
        'wake-sandbox',
      ],
    ]);
  });

  it('stops the sandbox container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.down('wake-sandbox');

    expect(calls).toEqual([['stop', 'wake-sandbox']]);
  });

  it('stops the sandbox container with a grace period when a timeout is provided', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.down('wake-sandbox', { timeoutSeconds: 3600 });

    expect(calls).toEqual([['stop', '--time', '3600', 'wake-sandbox']]);
  });

  it('passes the stop timeout through update when replacing a running container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => 'running',
      inspectImage: async () => true,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.update({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot: '/host/wake-home',
      containerHomeRoot: '/host/wake-home/container-home',
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      stopTimeoutSeconds: 3600,
    });

    expect(calls).toEqual([
      ['stop', '--time', '3600', 'wake-sandbox'],
      ['rm', 'wake-sandbox'],
      [
        'run',
        '-d',
        '--name',
        'wake-sandbox',
        '-v',
        '/host/wake-home:/wake',
        '-v',
        '/host/wake-home/container-home:/home/wake',
        'wake-sandbox',
      ],
    ]);
  });

  it('executes interactive commands with a tty inside the container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.exec('wake-sandbox', ['bash', '/wake/docker/setup.sh'], { interactive: true });

    expect(calls).toEqual([['exec', '-it', 'wake-sandbox', 'bash', '/wake/docker/setup.sh']]);
  });

  it('executes bash by default when no command is provided', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.exec('wake-sandbox', []);

    expect(calls).toEqual([['exec', '-it', 'wake-sandbox', 'bash']]);
  });

  it('executes the provided command inside the container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.exec('wake-sandbox', ['pwd']);

    expect(calls).toEqual([['exec', '-i', 'wake-sandbox', 'pwd']]);
  });

  it('spawns docker exec -i with piped stdio and forwards scrubbed stdout/stderr lines', async () => {
    const spawnCalls: string[][] = [];
    const fake = createFakeExecProcess();
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async () => {
        throw new Error('should not use run for execCaptured');
      },
      spawnExec: (args) => {
        spawnCalls.push(args);
        return fake.process;
      },
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const execPromise = docker.execCaptured('wake-sandbox', ['env'], {
      onStdout: (line) => stdoutLines.push(line),
      onStderr: (line) => stderrLines.push(line),
    });

    fake.stdout.write('GITHUB_TOKEN=abc123\n');
    fake.stdout.write('hello world\n');
    fake.stdout.end();
    fake.stderr.write('using token ghp_abcdefghijklmnop\n');
    fake.stderr.end();

    // Let the readline 'line' events for the writes above flush before close.
    await new Promise((r) => setImmediate(r));
    fake.emitClose(0);

    await execPromise;

    expect(spawnCalls).toEqual([['exec', '-i', 'wake-sandbox', 'env']]);
    expect(stdoutLines).toEqual(['GITHUB_TOKEN=[REDACTED]', 'hello world']);
    expect(stderrLines).toEqual(['using token [REDACTED]']);
  });

  it('rejects execCaptured when the process exits non-zero', async () => {
    const fake = createFakeExecProcess();
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async () => {
        throw new Error('should not use run for execCaptured');
      },
      spawnExec: () => fake.process,
    });

    const execPromise = docker.execCaptured('wake-sandbox', ['false'], {
      onStdout: () => {},
      onStderr: () => {},
    });

    fake.stdout.end();
    fake.stderr.end();
    fake.emitClose(1);

    await expect(execPromise).rejects.toThrow('failed with exit code 1');
  });

  it('rejects execCaptured when spawnExec was not configured', async () => {
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async () => {
        throw new Error('should not use run for execCaptured');
      },
    });

    await expect(
      docker.execCaptured('wake-sandbox', ['pwd'], { onStdout: () => {}, onStderr: () => {} }),
    ).rejects.toThrow('spawnExec');
  });

  it('tails docker container logs with a bounded line count', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.logs('wake-sandbox', 200);

    expect(calls).toEqual([['logs', '--tail', '200', 'wake-sandbox']]);
  });
});
