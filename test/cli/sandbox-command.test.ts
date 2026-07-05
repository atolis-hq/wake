import { resolve } from 'node:path';

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
      down: vi.fn(async () => {}),
      setup: vi.fn(async () => {}),
      exec: vi.fn(async () => {}),
    };
  }

  it('dispatches build with repo-root docker paths', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['build'],
      config: createDefaultWakeConfig(wakeRoot),
      repoRoot,
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

  it('dispatches up with config-derived container settings', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['up'],
      config: createDefaultWakeConfig(wakeRoot),
      repoRoot,
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
    });
  });

  it('dispatches down to the configured container name', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['down'],
      config: createDefaultWakeConfig(wakeRoot),
      repoRoot,
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.down).toHaveBeenCalledWith('wake-sandbox');
  });

  it('dispatches setup to the configured container name', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['setup'],
      config: createDefaultWakeConfig(wakeRoot),
      repoRoot,
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.setup).toHaveBeenCalledWith('wake-sandbox');
  });

  it('dispatches exec with the remaining command arguments', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['exec', 'pwd'],
      config: createDefaultWakeConfig(wakeRoot),
      repoRoot,
      wakeRoot,
      containerHomeRoot,
      docker,
    });

    expect(docker.exec).toHaveBeenCalledWith('wake-sandbox', ['pwd']);
  });

  it('rejects resume until the next task implements it', async () => {
    const docker = createDockerMock();

    await expect(
      runSandboxCommand({
        args: ['resume'],
        config: createDefaultWakeConfig(wakeRoot),
        repoRoot,
        wakeRoot,
        containerHomeRoot,
        docker,
      }),
    ).rejects.toThrow(/resume is not implemented yet/i);
  });

  it('rejects unknown sandbox subcommands', async () => {
    const docker = createDockerMock();

    await expect(
      runSandboxCommand({
        args: ['bogus'],
        config: createDefaultWakeConfig(wakeRoot),
        repoRoot,
        wakeRoot,
        containerHomeRoot,
        docker,
      }),
    ).rejects.toThrow('Unknown sandbox command: bogus');
  });
});
