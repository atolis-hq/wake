import { resolve } from 'node:path';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { runSandboxCommand } from '../../src/cli/sandbox-command.js';

describe('sandbox command', () => {
  const repoRoot = '/repo/wake';
  const wakeRoot = '/host/wake-home';
  const containerHomeRoot = '/host/wake-home/container-home';

  function createDockerMock() {
    return {
      build: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      exec: vi.fn(async () => {}),
      logs: vi.fn(async () => {}),
    };
  }

  it('dispatches build with repo-root docker paths', async () => {
    const docker = createDockerMock();
    const config = {
      ...createDefaultWakeConfig(wakeRoot),
      dev: {
        repoRoot,
      },
    };

    await runSandboxCommand({
      args: ['build'],
      config,
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.build).toHaveBeenCalledWith({
      image: 'wake-sandbox',
      dockerfile: resolve(repoRoot, 'docker', 'Dockerfile'),
      contextDir: '/repo/wake',
    });
  });

  it('rejects build when local-development repo root is missing', async () => {
    const docker = createDockerMock();

    await expect(
      runSandboxCommand({
        args: ['build'],
        config: createDefaultWakeConfig(wakeRoot),
        wakeRoot,
        containerHomeRoot,
        docker,
      }),
    ).rejects.toThrow('Sandbox build requires config.dev.repoRoot');
  });

  it('dispatches up with config-derived container settings', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['up'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.up).toHaveBeenCalledWith({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot,
      containerHomeRoot,
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      extraMounts: [],
    });
  });

  it('creates parent directories in container-home for extra file mounts under /home/wake before up', async () => {
    const docker = createDockerMock();
    const tempRoot = await mkdtemp(resolve(tmpdir(), 'wake-sandbox-command-'));
    const tempContainerHomeRoot = resolve(tempRoot, 'container-home');
    const config = createDefaultWakeConfig(wakeRoot);
    config.sandbox.extraMounts = [
      {
        source: '/host/.codex/config.toml',
        target: '/home/wake/.codex/config.toml',
      },
      {
        source: '/host/.claude/.credentials.json',
        target: '/home/wake/.claude/.credentials.json',
        readOnly: true,
      },
    ];

    await runSandboxCommand({
      args: ['up'],
      config,
      wakeRoot,
      containerHomeRoot: tempContainerHomeRoot,
      docker,
    });

    await expect(stat(resolve(tempContainerHomeRoot, '.codex'))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(stat(resolve(tempContainerHomeRoot, '.claude'))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it('dispatches down to the configured container name', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['down'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.down).toHaveBeenCalledWith('wake-sandbox');
  });

  it('dispatches update with config-derived container settings', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['update'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.update).toHaveBeenCalledWith({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot,
      containerHomeRoot,
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      extraMounts: [],
    });
  });

  it('dispatches setup to the configured container name', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['setup'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.exec).toHaveBeenCalledWith(
      'wake-sandbox',
      ['bash', '/wake/docker/setup.sh'],
      { interactive: true },
    );
  });

  it('dispatches exec with the remaining command arguments', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['exec', 'pwd'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.exec).toHaveBeenCalledWith(
      'wake-sandbox',
      expect.arrayContaining([
        'env',
        'WAKE_SANDBOX_LABEL=sandbox.exec',
        '/wake/docker/log-command.sh',
        '--',
        'pwd',
      ]),
    );
  });

  it('strips the command terminator before dispatching exec payload', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['exec', '--', 'node', '/app/dist/src/main.js', 'tick', '--wake-root', '/wake'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.exec).toHaveBeenCalledWith(
      'wake-sandbox',
      expect.arrayContaining([
        '/wake/docker/log-command.sh',
        '--',
        'node',
        '/app/dist/src/main.js',
        'tick',
        '--wake-root',
        '/wake',
      ]),
    );
  });

  it('dispatches resume through the sandbox resume command flow', async () => {
    const docker = createDockerMock();
    const config = createDefaultWakeConfig(wakeRoot);
    config.runner.mode = 'claude';

    await runSandboxCommand({
      args: ['resume', 'session-123', '--cwd', '/wake/workspaces/atolis-hq__wake/12'],
      config,
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.exec).toHaveBeenCalledWith(
      'wake-sandbox',
      expect.arrayContaining([
        'env',
        'WAKE_SANDBOX_LABEL=sandbox.resume',
        'WAKE_SANDBOX_CWD=/wake/workspaces/atolis-hq__wake/12',
        '/wake/docker/log-command.sh',
        '--',
        'claude',
        '--resume',
        'session-123',
      ]),
    );
  });

  it('tails the latest sandbox debug log through docker logs', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['logs'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.logs).toHaveBeenCalledWith('wake-sandbox', 200);
  });

  it('rejects unknown sandbox subcommands', async () => {
    const docker = createDockerMock();

    await expect(
      runSandboxCommand({
        args: ['bogus'],
        config: createDefaultWakeConfig(wakeRoot),
        wakeRoot,
        containerHomeRoot,
        docker,
      }),
    ).rejects.toThrow('Unknown sandbox command: bogus');
  });
});
