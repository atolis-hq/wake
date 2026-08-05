import { describe, expect, it } from 'vitest';
import {
  createDockerCli,
  createSandboxDockerPort,
  verifyResidentStart,
} from '../../../src-next/surfaces/cli/infrastructure/docker-cli.js';

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
    expect(calls).toEqual([
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
    ]);
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
    expect(calls).toEqual([
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
    ]);
  });

  it('omits build-args entirely when no version resolver is configured', async () => {
    const calls: string[][] = [];
    const docker = createSandboxDockerPort(
      createDockerCli(async (arguments_) => {
        calls.push([...arguments_]);
      }),
      { wakeRoot: '/wake-root', image: 'wake-sandbox', containerName: 'wake-sandbox' },
    );
    await docker.build();
    expect(calls).toEqual([
      ['build', '-t', 'wake-sandbox', '-f', '/wake-root/docker/Dockerfile', '/wake-root'],
    ]);
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
});
