import { describe, expect, it } from 'vitest';
import {
  createDockerCli,
  createLoggedDockerCli,
  createSandboxDockerPort,
  promoteSandboxImage,
  verifyResidentStart,
} from '../../../src/surfaces/cli/infrastructure/docker-cli.js';

describe('sandbox build version tagging', () => {
  it('stamps a source-mode build with the resolved version as WAKE_BUILD_TAG', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        development: { mode: 'source', repoRoot: '/repo-root' },
        resolveBuildVersion: async () => 'v1.2.3+gabc1234',
      },
    );
    await docker.build();
    expect(calls).toEqual(
      expect.arrayContaining([
        [
          'build',
          '-t',
          'wake-sandbox-runtime:managed',
          '-f',
          expect.stringContaining('docker/Dockerfile.runtime'),
          '--build-arg',
          'WAKE_BUILD_TAG=v1.2.3+gabc1234',
          '/repo-root',
        ],
        [
          'build',
          '-t',
          'wake-sandbox',
          '-f',
          '/wake-root/docker/Dockerfile',
          '--build-arg',
          'WAKE_BUILD_TAG=v1.2.3+gabc1234',
          '/repo-root',
        ],
      ]),
    );
  });

  it('stamps a packaged build with the resolved version as WAKE_VERSION', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      {
        wakeRoot: '/wake-root',
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        development: { mode: 'packaged' },
        resolveBuildVersion: async () => '1.4.0',
      },
    );
    await docker.build();
    expect(calls).toEqual(
      expect.arrayContaining([
        [
          'build',
          '-t',
          'wake-sandbox-runtime:managed',
          '-f',
          expect.stringContaining('docker/Dockerfile.runtime.packaged'),
          '--build-arg',
          'WAKE_VERSION=1.4.0',
          '/wake-root',
        ],
        [
          'build',
          '-t',
          'wake-sandbox',
          '-f',
          '/wake-root/docker/Dockerfile.packaged',
          '--build-arg',
          'WAKE_VERSION=1.4.0',
          '/wake-root',
        ],
      ]),
    );
  });

  it('uses the packaged Dockerfile when development mode is not configured', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
    );
    await docker.build();
    expect(calls).toEqual(
      expect.arrayContaining([
        [
          'build',
          '-t',
          'wake-sandbox-runtime:managed',
          '-f',
          expect.stringContaining('docker/Dockerfile.runtime.packaged'),
          '/wake-root',
        ],
        [
          'build',
          '-t',
          'wake-sandbox',
          '-f',
          '/wake-root/docker/Dockerfile.packaged',
          '/wake-root',
        ],
      ]),
    );
  });

  it('promotes a verified versioned image to the configured sandbox image', async () => {
    const calls: string[][] = [];
    await promoteSandboxImage(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      'wake-sandbox:1.4.0',
      'wake-sandbox',
    );
    expect(calls).toEqual([['tag', 'wake-sandbox:1.4.0', 'wake-sandbox']]);
  });

  it('does not retag when the verified image is already the configured image', async () => {
    const calls: string[][] = [];
    await promoteSandboxImage(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      'wake-sandbox',
      'wake-sandbox',
    );
    expect(calls).toEqual([]);
  });
});

describe('verifyResidentStart', () => {
  it('resolves once the in-container exec check succeeds', async () => {
    const calls: string[][] = [];
    const docker = createDockerCli(async (arguments_) => {
      calls.push([...arguments_]);
    });
    await verifyResidentStart(docker, 'wake-sandbox', 'wake start --wake-root /wake');
    expect(calls).toEqual([
      [
        'exec',
        '-i',
        'wake-sandbox',
        'sh',
        '-lc',
        'pid="$(cat /wake/.wake/logs/start.pid)" && test -n "$pid" && kill -0 "$pid" && ' +
          `tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -F 'wake start --wake-root /wake' >/dev/null`,
      ],
    ]);
  });

  it('retries on failure and eventually succeeds', async () => {
    let attempts = 0;
    const docker = createDockerCli(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('exec exited with code 1');
    });
    await verifyResidentStart(docker, 'wake-sandbox', 'wake start --wake-root /wake', {
      attempts: 5,
      intervalMs: 0,
    });
    expect(attempts).toBe(3);
  });

  it('throws after exhausting all attempts', async () => {
    let attempts = 0;
    const docker = createDockerCli(async () => {
      attempts += 1;
      throw new Error('exec exited with code 1');
    });
    await expect(
      verifyResidentStart(docker, 'wake-sandbox', 'wake start --wake-root /wake', {
        attempts: 3,
        intervalMs: 0,
      }),
    ).rejects.toThrow('exited with code 1');
    expect(attempts).toBe(3);
  });

  it('suppresses transient stale-PID probe output before the resident process becomes ready', async () => {
    const entries: string[] = [];
    let attempts = 0;
    const docker = createLoggedDockerCli(
      {
        execute: async (_arguments, onChunk) => {
          attempts += 1;
          if (attempts < 3) {
            await onChunk({ stream: 'stderr', text: 'sh: 1: kill: No such process\n' });
            throw new Error('docker exec exited with code 1');
          }
        },
      },
      {
        write: async (value) => {
          entries.push(value);
        },
        close: async () => {},
      },
    );

    await verifyResidentStart(docker, 'wake-sandbox', 'wake start --wake-root /wake', {
      attempts: 3,
      intervalMs: 0,
    });

    expect(attempts).toBe(3);
    expect(entries).toEqual([]);
  });

  it('reports the final captured probe output after all resident-start attempts fail', async () => {
    const entries: string[] = [];
    let attempts = 0;
    const docker = createLoggedDockerCli(
      {
        execute: async (_arguments, onChunk) => {
          attempts += 1;
          if (attempts === 1) {
            await onChunk({ stream: 'stderr', text: 'sh: 1: kill: No such process\n' });
          } else {
            await onChunk({ stream: 'stdout', text: 'pid=219\n' });
            await onChunk({ stream: 'stderr', text: 'sh: 1: kill: No such process\n' });
          }
          throw new Error('docker exec exited with code 1');
        },
      },
      {
        write: async (value) => {
          entries.push(value);
        },
        close: async () => {},
      },
    );

    await expect(
      verifyResidentStart(docker, 'wake-sandbox', 'wake start --wake-root /wake', {
        attempts: 2,
        intervalMs: 0,
      }),
    ).rejects.toThrow(/resident start.*pid=219.*kill: No such process/is);

    expect(attempts).toBe(2);
    expect(entries).toEqual(['pid=219\n', 'sh: 1: kill: No such process\n']);
  });
});
