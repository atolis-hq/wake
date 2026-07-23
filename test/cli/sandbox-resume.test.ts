import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { runSandboxResumeCommand, chooseResumeTarget } from '../../src/cli/sandbox-resume.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';

describe('sandbox resume command', () => {
  it('executes claude resume in the requested workspace for explicit inputs', async () => {
    const calls: unknown[][] = [];
    const docker = {
      execCaptured: async (containerName: string, command: string[], handlers: unknown) => {
        calls.push([containerName, command, handlers]);
      },
    };

    await runSandboxResumeCommand({
      args: ['session-123', '--cwd', '/wake/workspaces/atolis-hq__wake/12'],
      config: createDefaultWakeConfig('/wake-home'),
      docker,
      wakeRoot: '/wake-home',
      containerHomeRoot: '/wake-home/container-home',
      buildResumeCommand: ({ sessionId }) => ['claude', '--resume', sessionId],
      logger: { info: () => {} },
    });

    expect(calls).toHaveLength(1);
    const [containerName, command] = calls[0] as [string, string[], unknown];
    expect(containerName).toBe('wake-sandbox');
    expect(command).toEqual([
      'sh',
      '-c',
      "cd '/wake/workspaces/atolis-hq__wake/12' && 'claude' '--resume' 'session-123'",
    ]);
  });

  it('executes codex resume in the requested workspace when the runner adapter provides it', async () => {
    const calls: unknown[][] = [];
    const docker = {
      execCaptured: async (containerName: string, command: string[], handlers: unknown) => {
        calls.push([containerName, command, handlers]);
      },
    };

    const config = createDefaultWakeConfig('/wake-home');

    await runSandboxResumeCommand({
      args: ['session-456', '--cwd', '/wake/workspaces/atolis-hq__wake/34'],
      config,
      docker,
      wakeRoot: '/wake-home',
      containerHomeRoot: '/wake-home/container-home',
      buildResumeCommand: ({ sessionId }) => ['codex', 'resume', sessionId],
      logger: { info: () => {} },
    });

    expect(calls).toHaveLength(1);
    const [containerName, command] = calls[0] as [string, string[], unknown];
    expect(containerName).toBe('wake-sandbox');
    expect(command).toEqual([
      'sh',
      '-c',
      "cd '/wake/workspaces/atolis-hq__wake/34' && 'codex' 'resume' 'session-456'",
    ]);
  });

  it('forwards execCaptured stdout/stderr lines to the logger in real time', async () => {
    const docker = {
      execCaptured: async (
        _containerName: string,
        _command: string[],
        handlers: { onStdout: (line: string) => void; onStderr: (line: string) => void },
      ) => {
        handlers.onStdout('resumed session output');
        handlers.onStderr('warning: something');
      },
    };
    const info = vi.fn();
    const error = vi.fn();

    await runSandboxResumeCommand({
      args: ['session-123', '--cwd', '/wake/workspaces/atolis-hq__wake/12'],
      config: createDefaultWakeConfig('/wake-home'),
      docker,
      wakeRoot: '/wake-home',
      containerHomeRoot: '/wake-home/container-home',
      buildResumeCommand: ({ sessionId }) => ['claude', '--resume', sessionId],
      logger: { info, error },
    });

    expect(info).toHaveBeenCalledWith('resumed session output');
    expect(error).toHaveBeenCalledWith('warning: something');
  });

  it('throws if the caller does not provide runner-specific resume wiring', async () => {
    const docker = {
      execCaptured: async () => {
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
        logger: { info: () => {} },
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
        workItemKey: 'work-01JZ0000000000000000000022',
        repo: 'atolis-hq/wake',
        issueNumber: 22,
        action: 'implement',
        status: 'completed',
        startedAt: '2026-07-06T10:00:00.000Z',
        finishedAt: '2026-07-06T10:05:00.000Z',
        sessionId: 'session-22',
      });
      await writeFile(join(store.paths.dataRoot, 'runs', 'notes.txt'), 'ignore me', 'utf8');
      await mkdir(join(root, 'workspaces', 'atolis-hq__wake', '22'), { recursive: true });

      let seenOptions:
        Array<{ label: string; value: { sessionId: string; workspacePath: string } }> | undefined;
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
