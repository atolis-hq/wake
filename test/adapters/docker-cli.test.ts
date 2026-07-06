import { describe, expect, it } from 'vitest';

import { createDockerCli } from '../../src/adapters/docker/docker-cli.js';

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

  it('runs the sandbox setup script inside the container', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli({
      inspectContainer: async () => null,
      inspectImage: async () => false,
      run: async (args) => {
        calls.push(args);
      },
    });

    await docker.setup('wake-sandbox');

    expect(calls).toEqual([['exec', '-it', 'wake-sandbox', 'bash', '/wake/docker/setup.sh']]);
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

    await docker.execInteractive('wake-sandbox', ['bash', '/wake/docker/setup.sh']);

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
