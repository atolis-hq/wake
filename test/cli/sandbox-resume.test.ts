import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { runSandboxResumeCommand, chooseResumeTarget } from '../../src/cli/sandbox-resume.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';

describe('sandbox resume command', () => {
  it('executes claude resume in the requested workspace for explicit inputs', async () => {
    const calls: Array<{ containerName: string; args: string[] }> = [];
    const docker = {
      exec: async (containerName: string, args: string[]) => {
        calls.push({ containerName, args });
      },
    };

    await runSandboxResumeCommand({
      args: ['session-123', '--cwd', '/wake/workspaces/atolis-hq__wake/12'],
      config: createDefaultWakeConfig('/wake-home'),
      docker,
      wakeRoot: '/wake-home',
    });

    expect(calls).toEqual([
      {
        containerName: 'wake-sandbox',
        args: [
          'bash',
          '-lc',
          'cd "/wake/workspaces/atolis-hq__wake/12" && claude --resume session-123',
        ],
      },
    ]);
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
