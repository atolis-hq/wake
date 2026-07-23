import { resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { runSandboxCommand } from '../../src/cli/sandbox-command.js';

describe('sandbox command', () => {
  const repoRoot = '/repo/wake';
  const wakeRoot = '/host/wake-home';
  const containerHomeRoot = '/host/wake-home/container-home';
  const packagedTemplatesRoot = resolve(process.cwd(), 'docker');

  async function makeTempWakeRoot(): Promise<string> {
    return mkdtemp(resolve(tmpdir(), 'wake-sandbox-command-dockerfile-'));
  }

  function createDockerMock() {
    return {
      build: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      exec: vi.fn(async () => {}),
      execCaptured: vi.fn(
        async (
          _containerName: string,
          _command: string[],
          _handlers: { onStdout: (line: string) => void; onStderr: (line: string) => void },
        ) => {},
      ),
      logs: vi.fn(async () => {}),
    };
  }

  it('dispatches build with the generated Dockerfile and repo-root context', async () => {
    const docker = createDockerMock();
    const tempWakeRoot = await makeTempWakeRoot();
    await mkdir(resolve(tempWakeRoot, 'docker'), { recursive: true });
    await writeFile(resolve(tempWakeRoot, 'docker', 'Dockerfile'), 'EXISTING', 'utf8');
    const config = {
      ...createDefaultWakeConfig(tempWakeRoot),
      dev: {
        repoRoot,
        mode: 'source' as const,
      },
    };

    await runSandboxCommand({
      args: ['build'],
      config,
      wakeRoot: tempWakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.build).toHaveBeenCalledWith({
      image: 'wake-sandbox',
      dockerfile: resolve(tempWakeRoot, 'docker', 'Dockerfile'),
      contextDir: '/repo/wake',
    });
  });

  it('defaults to packaged mode (Dockerfile.packaged template, WAKE_VERSION build arg) when dev.mode is unset', async () => {
    const tempWakeRoot = await makeTempWakeRoot();
    const docker = createDockerMock();
    const config = {
      ...createDefaultWakeConfig(tempWakeRoot),
      dev: { repoRoot },
    };

    await runSandboxCommand({
      args: ['build'],
      config,
      wakeRoot: tempWakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    const written = await readFile(resolve(tempWakeRoot, 'docker', 'Dockerfile'), 'utf8');
    expect(written).toContain('"@atolis-hq/wake@');
    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({
        buildArgs: { WAKE_VERSION: expect.any(String) },
      }),
    );
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
        packagedTemplatesRoot,
        stateStore: { listRunRecords: async () => [] },
        sleep: async () => {},
        logger: { info: () => {} },
      }),
    ).rejects.toThrow('Sandbox build requires config.dev.repoRoot');
  });

  it('writes docker/Dockerfile from the source template when missing and dev.mode is "source"', async () => {
    const tempWakeRoot = await makeTempWakeRoot();
    const dockerBuild = vi.fn(async () => {});
    const docker = { ...createDockerMock(), build: dockerBuild };
    const config = {
      ...createDefaultWakeConfig(tempWakeRoot),
      dev: { repoRoot, mode: 'source' as const },
    };

    await runSandboxCommand({
      args: ['build'],
      config,
      wakeRoot: tempWakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    const written = await readFile(resolve(tempWakeRoot, 'docker', 'Dockerfile'), 'utf8');
    expect(written).toContain('npm run build');
    expect(dockerBuild).toHaveBeenCalled();
  });

  it('writes docker/Dockerfile from the packaged template when missing and dev.mode is "packaged"', async () => {
    const tempWakeRoot = await makeTempWakeRoot();
    const docker = createDockerMock();
    const config = {
      ...createDefaultWakeConfig(tempWakeRoot),
      dev: { repoRoot, mode: 'packaged' as const },
    };

    await runSandboxCommand({
      args: ['build'],
      config,
      wakeRoot: tempWakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    const written = await readFile(resolve(tempWakeRoot, 'docker', 'Dockerfile'), 'utf8');
    expect(written).toContain('"@atolis-hq/wake@');
    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({
        buildArgs: { WAKE_VERSION: expect.any(String) },
      }),
    );
  });

  it('leaves an existing docker/Dockerfile untouched on a second build', async () => {
    const tempWakeRoot = await makeTempWakeRoot();
    const docker = createDockerMock();
    await mkdir(resolve(tempWakeRoot, 'docker'), { recursive: true });
    await writeFile(resolve(tempWakeRoot, 'docker', 'Dockerfile'), 'CUSTOM CONTENT', 'utf8');
    const config = {
      ...createDefaultWakeConfig(tempWakeRoot),
      dev: { repoRoot, mode: 'packaged' as const },
    };

    await runSandboxCommand({
      args: ['build'],
      config,
      wakeRoot: tempWakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    const written = await readFile(resolve(tempWakeRoot, 'docker', 'Dockerfile'), 'utf8');
    expect(written).toBe('CUSTOM CONTENT');
  });

  it('dispatches up with config-derived container settings', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['up'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.up).toHaveBeenCalledWith({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot,
      containerHomeRoot,
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      extraMounts: [],
      ui: { enabled: false, port: 4317, token: undefined, tunnel: { enabled: false } },
      start: { enabled: true },
    });
  });

  it('forwards ui.enabled, port, and token from config to docker up', async () => {
    const docker = createDockerMock();
    const config = createDefaultWakeConfig(wakeRoot);
    config.ui = {
      enabled: true,
      port: 4400,
      token: 'secret-token',
      tunnel: { enabled: true, authToken: 'ngrok-token' },
      archiveFreshnessDays: 5,
    };

    await runSandboxCommand({
      args: ['up'],
      config,
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.up).toHaveBeenCalledWith(
      expect.objectContaining({
        ui: {
          enabled: true,
          port: 4400,
          token: 'secret-token',
          tunnel: { enabled: true, authToken: 'ngrok-token' },
        },
        start: { enabled: true },
      }),
    );
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
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
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
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.down).toHaveBeenCalledWith('wake-sandbox');
  });

  it('waits for active runs before stopping via sandbox stop', async () => {
    const docker = createDockerMock();
    let calls = 0;
    const listRunRecords = vi.fn(async () => {
      calls += 1;
      return calls < 2 ? [{ status: 'running' }] : [{ status: 'completed' }];
    });

    await runSandboxCommand({
      args: ['stop'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords } as never,
      sleep: vi.fn(async () => {}),
      logger: { info: () => {} },
    });

    expect(listRunRecords).toHaveBeenCalledTimes(2);
    expect(docker.down).toHaveBeenCalledWith('wake-sandbox', { timeoutSeconds: 60 });
  });

  it('dispatches update with config-derived container settings', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['update'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.update).toHaveBeenCalledWith({
      image: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeRoot,
      containerHomeRoot,
      containerMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      extraMounts: [],
      ui: { enabled: false, port: 4317, token: undefined, tunnel: { enabled: false } },
      start: { enabled: true },
    });
  });

  it('dispatches self-update with git, ledger, and issue-reporter deps', async () => {
    const docker = createDockerMock();
    const config = {
      ...createDefaultWakeConfig(wakeRoot),
      dev: { repoRoot },
      ui: {
        enabled: true,
        port: 4400,
        token: 'secret-token',
        tunnel: { enabled: false },
        archiveFreshnessDays: 5,
      },
    };
    const checkoutTag = vi.fn(async () => {});
    const createIssue = vi.fn(async () => {});
    const writeLedger = vi.fn(async () => {});

    await runSandboxCommand({
      args: ['self-update', '--tag', 'v0.0.80', '--force'],
      config,
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] } as never,
      sleep: vi.fn(async () => {}),
      logger: { info: () => {} },
      selfUpdate: {
        git: {
          latestTag: vi.fn(async () => 'v0.0.79'),
          isWorkingTreeClean: vi.fn(async () => true),
          checkoutTag,
        },
        issueReporter: { createIssue },
        readLedger: vi.fn(async () => ({
          lastAppliedTag: 'v0.0.79',
          lastKnownGoodTag: 'v0.0.79',
          badTags: [],
        })),
        writeLedger,
      },
    });

    expect(checkoutTag).toHaveBeenCalledWith('v0.0.80');
    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(docker.update).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'wake-sandbox:v0.0.80',
        ui: {
          enabled: true,
          port: 4400,
          token: 'secret-token',
          tunnel: { enabled: false },
        },
        start: { enabled: true },
      }),
    );
    expect(writeLedger).toHaveBeenCalledWith(
      expect.objectContaining({ lastAppliedTag: 'v0.0.80' }),
    );
  });

  it('dispatches self-update --loop through the continuous loop path', async () => {
    const docker = createDockerMock();
    const config = { ...createDefaultWakeConfig(wakeRoot), dev: { repoRoot } };
    let sleepCalls = 0;
    const sleep = vi.fn(async () => {
      sleepCalls += 1;
      if (sleepCalls >= 1) {
        throw new Error('STOP_TEST_LOOP');
      }
    });

    await expect(
      runSandboxCommand({
        args: ['self-update', '--tag', 'v0.0.80', '--force', '--loop', '--loop-interval-ms', '50'],
        config,
        wakeRoot,
        containerHomeRoot,
        docker,
        packagedTemplatesRoot,
        stateStore: { listRunRecords: async () => [] } as never,
        sleep,
        logger: { info: () => {}, error: () => {} },
        selfUpdate: {
          git: {
            latestTag: vi.fn(async () => 'v0.0.79'),
            isWorkingTreeClean: vi.fn(async () => true),
            checkoutTag: vi.fn(async () => {}),
          },
          issueReporter: { createIssue: vi.fn(async () => {}) },
          readLedger: vi.fn(async () => ({
            lastAppliedTag: 'v0.0.79',
            lastKnownGoodTag: 'v0.0.79',
            badTags: [],
          })),
          writeLedger: vi.fn(async () => {}),
        },
      }),
    ).rejects.toThrow('STOP_TEST_LOOP');

    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('dispatches setup via the bare wake binary when dev.mode is packaged or unset', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['setup'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.exec).toHaveBeenCalledWith('wake-sandbox', ['wake', 'sandbox-setup'], {
      interactive: true,
    });
  });

  it('dispatches setup via node /app/dist/src/main.js when dev.mode is source', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['setup'],
      config: { ...createDefaultWakeConfig(wakeRoot), dev: { mode: 'source' } },
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.exec).toHaveBeenCalledWith(
      'wake-sandbox',
      ['node', '/app/dist/src/main.js', 'sandbox-setup'],
      { interactive: true },
    );
  });

  it('dispatches exec with the remaining command arguments through execCaptured', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['exec', 'pwd'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.execCaptured).toHaveBeenCalledWith(
      'wake-sandbox',
      ['pwd'],
      expect.objectContaining({ onStdout: expect.any(Function), onStderr: expect.any(Function) }),
    );
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('strips the command terminator before dispatching the exec payload', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['exec', '--', 'node', '/app/dist/src/main.js', 'tick', '--wake-root', '/wake'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.execCaptured).toHaveBeenCalledWith(
      'wake-sandbox',
      ['node', '/app/dist/src/main.js', 'tick', '--wake-root', '/wake'],
      expect.objectContaining({ onStdout: expect.any(Function), onStderr: expect.any(Function) }),
    );
  });

  it('falls back to an interactive shell via docker.exec when no exec command is given', async () => {
    const docker = createDockerMock();

    await runSandboxCommand({
      args: ['exec'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.exec).toHaveBeenCalledWith('wake-sandbox', []);
    expect(docker.execCaptured).not.toHaveBeenCalled();
  });

  it('forwards execCaptured stdout/stderr lines to the logger in real time', async () => {
    const docker = createDockerMock();
    docker.execCaptured.mockImplementation(async (_containerName, _command, handlers) => {
      handlers.onStdout('build ok');
      handlers.onStderr('warning: something');
    });
    const info = vi.fn();
    const error = vi.fn();

    await runSandboxCommand({
      args: ['exec', 'pwd'],
      config: createDefaultWakeConfig(wakeRoot),
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info, error },
    });

    expect(info).toHaveBeenCalledWith('build ok');
    expect(error).toHaveBeenCalledWith('warning: something');
  });

  it('dispatches resume through the sandbox resume command flow', async () => {
    const docker = createDockerMock();
    const config = createDefaultWakeConfig(wakeRoot);
    config.runners['claude-haiku'] = {
      kind: 'claude',
      command: 'claude',
      model: 'claude-haiku-4-5',
      smokeModel: 'claude-haiku-4-5',
      sessionName: 'Wake',
      remoteControlName: 'Wake',
      smokePrompt: 'hi',
      timeoutMs: 600_000,
      remoteControl: { enabled: false },
      models: {},
    };

    await runSandboxCommand({
      args: ['resume', 'session-123', '--cwd', '/wake/workspaces/atolis-hq__wake/12'],
      config,
      wakeRoot,
      containerHomeRoot,
      docker,
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
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
      packagedTemplatesRoot,
      stateStore: { listRunRecords: async () => [] },
      sleep: async () => {},
      logger: { info: () => {} },
    });

    expect(docker.logs).toHaveBeenCalledWith('wake-sandbox', 200);
  });

  it('throws a dev.mode-specific error for self-update when selfUpdate deps are undefined', async () => {
    const docker = createDockerMock();
    const config = {
      ...createDefaultWakeConfig(wakeRoot),
      dev: { repoRoot: '/repo', mode: 'packaged' as const },
    };

    await expect(
      runSandboxCommand({
        args: ['self-update'],
        config,
        wakeRoot,
        containerHomeRoot,
        docker,
        packagedTemplatesRoot,
        stateStore: { listRunRecords: async () => [] },
        sleep: async () => {},
        logger: { info: () => {} },
        selfUpdate: undefined,
      }),
    ).rejects.toThrow(/dev\.mode: "source"/);
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
        packagedTemplatesRoot,
        stateStore: { listRunRecords: async () => [] },
        sleep: async () => {},
        logger: { info: () => {} },
      }),
    ).rejects.toThrow('Unknown sandbox command: bogus');
  });
});
