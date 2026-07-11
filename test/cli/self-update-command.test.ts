import { describe, expect, it, vi } from 'vitest';

import { runSelfUpdateCommand } from '../../src/cli/self-update-command.js';
import type { SelfUpdateLedger } from '../../src/adapters/fs/self-update-ledger.js';

function baseDeps(overrides: Record<string, unknown> = {}) {
  const ledger: SelfUpdateLedger = {
    lastAppliedTag: 'v0.0.79',
    lastKnownGoodTag: 'v0.0.79',
    badTags: [],
  };

  return {
    args: [],
    repoRoot: '/repo/wake',
    imageRepository: 'wake-sandbox',
    containerName: 'wake-sandbox',
    stateStore: { listRunRecords: async () => [] },
    docker: {
      build: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      exec: vi.fn(async () => {}),
    },
    git: {
      latestTag: vi.fn(async () => 'v0.0.80'),
      isWorkingTreeClean: vi.fn(async () => true),
      checkoutTag: vi.fn(async () => {}),
    },
    issueReporter: { createIssue: vi.fn(async () => {}) },
    readLedger: vi.fn(async () => ledger),
    writeLedger: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    logger: { info: () => {}, error: () => {} },
    wakeRoot: '/host/wake-home',
    containerHomeRoot: '/host/wake-home/container-home',
    containerMountPath: '/wake',
    containerHomeMountPath: '/home/wake',
    dockerfilePath: '/repo/wake/docker/Dockerfile',
    ...overrides,
  };
}

describe('runSelfUpdateCommand', () => {
  it('does nothing when the latest tag matches the last applied tag', async () => {
    const deps = baseDeps({
      git: {
        latestTag: vi.fn(async () => 'v0.0.79'),
        isWorkingTreeClean: vi.fn(async () => true),
        checkoutTag: vi.fn(async () => {}),
      },
    });

    await runSelfUpdateCommand(deps as never);

    expect((deps.docker as { build: ReturnType<typeof vi.fn> }).build).not.toHaveBeenCalled();
  });

  it('skips a tag already recorded as bad, unless --force is passed', async () => {
    const ledger: SelfUpdateLedger = {
      lastAppliedTag: 'v0.0.79',
      lastKnownGoodTag: 'v0.0.79',
      badTags: [{ tag: 'v0.0.80', reason: 'boom', recordedAt: '2026-07-11T00:00:00.000Z' }],
    };
    const deps = baseDeps({ readLedger: vi.fn(async () => ledger) });

    await runSelfUpdateCommand(deps as never);

    expect((deps.docker as { build: ReturnType<typeof vi.fn> }).build).not.toHaveBeenCalled();
  });

  it('builds, updates, health-checks, and records success on a new tag', async () => {
    const deps = baseDeps();

    await runSelfUpdateCommand(deps as never);

    const git = deps.git as { checkoutTag: ReturnType<typeof vi.fn> };
    const docker = deps.docker as {
      build: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      exec: ReturnType<typeof vi.fn>;
    };
    const writeLedger = deps.writeLedger as ReturnType<typeof vi.fn>;
    const issueReporter = deps.issueReporter as { createIssue: ReturnType<typeof vi.fn> };

    expect(git.checkoutTag).toHaveBeenCalledWith('v0.0.80');
    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(docker.update).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(docker.exec).toHaveBeenCalledWith('wake-sandbox', [
      'node',
      '/app/dist/src/main.js',
      'tick',
      '--wake-root',
      '/tmp/wake-self-update-healthcheck',
    ]);
    expect(writeLedger).toHaveBeenCalledWith(
      expect.objectContaining({ lastAppliedTag: 'v0.0.80', lastKnownGoodTag: 'v0.0.80' }),
    );
    expect(issueReporter.createIssue).not.toHaveBeenCalled();
  });

  it('rolls back and files an issue when the health check fails', async () => {
    const deps = baseDeps({
      docker: {
        build: vi.fn(async () => {}),
        update: vi.fn(async () => {}),
        exec: vi.fn(async () => {
          throw new Error('tick exited 1');
        }),
      },
    });

    await runSelfUpdateCommand(deps as never);

    const docker = deps.docker as { update: ReturnType<typeof vi.fn> };
    const writeLedger = deps.writeLedger as ReturnType<typeof vi.fn>;
    const issueReporter = deps.issueReporter as { createIssue: ReturnType<typeof vi.fn> };

    expect(docker.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ image: 'wake-sandbox:v0.0.80' }),
    );
    expect(docker.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ image: 'wake-sandbox:v0.0.79' }),
    );
    expect(writeLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        lastAppliedTag: 'v0.0.79',
        lastKnownGoodTag: 'v0.0.79',
        badTags: [expect.objectContaining({ tag: 'v0.0.80' })],
      }),
    );
    expect(issueReporter.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('v0.0.80'),
        body: expect.stringContaining('tick exited 1'),
      }),
    );
  });

  it('refuses to proceed when the working tree is dirty', async () => {
    const deps = baseDeps({
      git: {
        latestTag: vi.fn(async () => 'v0.0.80'),
        isWorkingTreeClean: vi.fn(async () => false),
        checkoutTag: vi.fn(async () => {}),
      },
    });

    await expect(runSelfUpdateCommand(deps as never)).rejects.toThrow(
      'working tree has local changes',
    );
    expect((deps.docker as { build: ReturnType<typeof vi.fn> }).build).not.toHaveBeenCalled();
  });

  it('supports --tag to target an explicit tag regardless of git state', async () => {
    const deps = baseDeps({
      args: ['--tag', 'v0.0.81', '--force'],
      git: {
        latestTag: vi.fn(async () => 'v0.0.79'),
        isWorkingTreeClean: vi.fn(async () => true),
        checkoutTag: vi.fn(async () => {}),
      },
    });

    await runSelfUpdateCommand(deps as never);

    const git = deps.git as { checkoutTag: ReturnType<typeof vi.fn> };
    const docker = deps.docker as { build: ReturnType<typeof vi.fn> };

    expect(git.checkoutTag).toHaveBeenCalledWith('v0.0.81');
    expect(docker.build).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'wake-sandbox:v0.0.81' }),
    );
  });
});
