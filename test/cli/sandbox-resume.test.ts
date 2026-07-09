import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { runSandboxResumeCommand, chooseResumeTarget } from '../../src/cli/sandbox-resume.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';

describe('sandbox resume command', () => {
  it('executes claude resume in the requested workspace for explicit inputs', async () => {
    const calls: string[][] = [];
    const docker = {
      exec: async (containerName: string, args: string[]) => {
        calls.push(['exec', '-it', containerName, ...args]);
      },
    };

    await runSandboxResumeCommand({
      args: ['session-123', '--cwd', '/wake/workspaces/atolis-hq__wake/12'],
      config: createDefaultWakeConfig('/wake-home'),
      docker,
      wakeRoot: '/wake-home',
      containerHomeRoot: '/wake-home/container-home',
      buildResumeCommand: ({ sessionId }) => ['claude', '--resume', sessionId],
    });

    expect(calls).toEqual([
      [
        'exec',
        '-it',
        'wake-sandbox',
        'env',
        'WAKE_SANDBOX_LABEL=sandbox.resume',
        'WAKE_SANDBOX_CONTAINER_WAKE_ROOT=/wake',
        'WAKE_SANDBOX_PROMPTS_ROOT=/wake/prompts',
        'WAKE_SANDBOX_CONTAINER_HOME=/home/wake',
        'WAKE_SANDBOX_HOST_WAKE_ROOT=/wake-home',
        'WAKE_SANDBOX_HOST_CONTAINER_HOME=/wake-home/container-home',
        'WAKE_SANDBOX_CONTAINER_MOUNT=/wake',
        'WAKE_SANDBOX_CONTAINER_NAME=wake-sandbox',
        'WAKE_SANDBOX_CWD=/wake/workspaces/atolis-hq__wake/12',
        '/wake/docker/log-command.sh',
        '--',
        'claude',
        '--resume',
        'session-123',
      ],
    ]);
  });

  it('executes codex resume in the requested workspace when the runner adapter provides it', async () => {
    const calls: string[][] = [];
    const docker = {
      exec: async (containerName: string, args: string[]) => {
        calls.push(['exec', '-it', containerName, ...args]);
      },
    };

    const config = createDefaultWakeConfig('/wake-home');
    config.runner.mode = 'codex';

    await runSandboxResumeCommand({
      args: ['session-456', '--cwd', '/wake/workspaces/atolis-hq__wake/34'],
      config,
      docker,
      wakeRoot: '/wake-home',
      containerHomeRoot: '/wake-home/container-home',
      buildResumeCommand: ({ sessionId }) => ['codex', 'resume', sessionId],
    });

    expect(calls).toEqual([
      [
        'exec',
        '-it',
        'wake-sandbox',
        'env',
        'WAKE_SANDBOX_LABEL=sandbox.resume',
        'WAKE_SANDBOX_CONTAINER_WAKE_ROOT=/wake',
        'WAKE_SANDBOX_PROMPTS_ROOT=/wake/prompts',
        'WAKE_SANDBOX_CONTAINER_HOME=/home/wake',
        'WAKE_SANDBOX_HOST_WAKE_ROOT=/wake-home',
        'WAKE_SANDBOX_HOST_CONTAINER_HOME=/wake-home/container-home',
        'WAKE_SANDBOX_CONTAINER_MOUNT=/wake',
        'WAKE_SANDBOX_CONTAINER_NAME=wake-sandbox',
        'WAKE_SANDBOX_CWD=/wake/workspaces/atolis-hq__wake/34',
        '/wake/docker/log-command.sh',
        '--',
        'codex',
        'resume',
        'session-456',
      ],
    ]);
  });

  it('throws if the caller does not provide runner-specific resume wiring', async () => {
    const docker = {
      exec: async () => {
        throw new Error('should not execute');
      },
    };

    await expect(
      runSandboxResumeCommand({
        args: ['session-789', '--cwd', '/wake/workspaces/atolis-hq__wake/56'],
        config: createDefaultWakeConfig('/wake-home'),
        docker,
        wakeRoot: '/wake-home',
        containerHomeRoot: '/wake-home/container-home',
        // @ts-expect-error intentional runtime coverage for missing adapter wiring
        buildResumeCommand: undefined,
      }),
    ).rejects.toThrow();
  });

  describe('chooseResumeTarget', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'wake-sandbox-resume-'));
    });

    it('lists resumable runs and returns the selected session and workspace path', async () => {
      const store = createStateStore({ wakeRoot: root });

      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-22',
        repo: 'atolis-hq/wake',
        issueNumber: 22,
        action: 'implement',
        status: 'completed',
        startedAt: '2026-07-06T10:00:00.000Z',
        finishedAt: '2026-07-06T10:05:00.000Z',
        sessionId: 'session-22',
      });
      await writeFile(join(root, 'runs', 'notes.txt'), 'ignore me', 'utf8');
      await mkdir(join(root, 'workspaces', 'atolis-hq__wake', '22'), { recursive: true });

      let seenOptions:
        | Array<{ label: string; value: { sessionId: string; workspacePath: string } }>
        | undefined;
      const target = await chooseResumeTarget({
        wakeRoot: root,
        select: async (options) => {
          seenOptions = options;
          return options[0] ?? null;
        },
      });

      expect(seenOptions?.[0]?.label).toContain('atolis-hq/wake#22');
      expect(target).toMatchObject({ sessionId: 'session-22' });
    });
  });
});
