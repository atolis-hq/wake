import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  buildStagePrompt,
  buildClaudePrintArgs,
  buildClaudeRemoteControlArgs,
  buildEddySessionName,
  formatClaudeRunLogLine,
  runClaudeCommand,
} from '../../src/adapters/claude/claude-runner.js';
import type { WakeConfig } from '../../src/domain/types.js';
import { defaultSmokePrompt } from '../../src/config/defaults.js';

describe('claude runner command building', () => {
  const baseProjection = {
    schemaVersion: 1 as const,
    workItemKey: 'atolis-hq/wake#12',
    issue: {
      repo: 'atolis-hq/wake',
      number: 12,
      title: 'Example issue',
      body: 'Body',
      labels: ['wake:refined'],
      assignees: [],
      state: 'open' as const,
      url: 'https://example.test/issues/12',
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:00:00.000Z',
    },
    comments: [],
    wake: {
      stage: 'refined' as const,
      stageHistory: [],
      recentEventIds: [],
      syncedAt: '2026-07-05T12:00:00.000Z',
    },
    context: {},
  };

  it('builds a minimal haiku print invocation for smoke tests', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: defaultSmokePrompt,
      sessionName: 'Eddy',
    });

    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });

  it('builds a remote-control smoke invocation', () => {
    const args = buildClaudeRemoteControlArgs({
      model: 'haiku',
      prompt: defaultSmokePrompt,
      remoteControlName: 'Eddy',
      sessionName: 'Eddy',
    });

    expect(args).toContain('--remote-control');
    expect(args).toContain('--bg');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });

  it('assembles a stage prompt from a projection summary and its comments', async () => {
    const result = await buildStagePrompt({
      action: 'implement',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#12',
        issue: {
          repo: 'atolis-hq/wake',
          number: 12,
          title: 'Example issue',
          body: 'Body',
          labels: ['wake:refined'],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/12',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [
          {
            id: 'c-2',
            body: 'Please proceed',
            author: { login: 'shared-user' },
            createdAt: '2026-07-05T12:01:00.000Z',
            updatedAt: '2026-07-05T12:01:00.000Z',
            isWakeAuthored: false,
            isBotAuthored: false,
          },
        ],
        latestComment: {
          id: 'c-2',
          body: 'Please proceed',
          author: { login: 'shared-user' },
          createdAt: '2026-07-05T12:01:00.000Z',
          updatedAt: '2026-07-05T12:01:00.000Z',
          isWakeAuthored: false,
          isBotAuthored: false,
        },
        wake: {
          stage: 'refined',
          stageHistory: [],
          recentEventIds: ['evt-1'],
          syncedAt: '2026-07-05T12:01:00.000Z',
        },
        context: {},
      },
    });

    expect(result.prompt).toContain('IMPLEMENT stage');
    expect(result.prompt).toContain('atolis-hq/wake#12');
    expect(result.prompt).toContain('shared-user');
    expect(result.prompt).toContain('Please proceed');
    expect(result.prompt).toContain('wake/issue-12');
    expect(result.prompt).toContain('git push -u origin wake/issue-12');
    expect(result.prompt).toContain('gh pr create');
    expect(result.prompt).toContain('Closes #12');
    expect(result.permissionMode).toBe('acceptEdits');
    expect(result.allowedTools).toContain('Edit');
    expect(result.allowedTools).toContain('Bash(git *)');
    expect(result.extraArgs).toEqual([]);
  });

  it('requires AWAITING_APPROVAL, not DONE, for successful built-in prompts when approval is required', async () => {
    for (const action of ['refine', 'implement'] as const) {
      for (const mode of ['start', 'resume'] as const) {
        const result = await buildStagePrompt({
          action,
          mode,
          projection: baseProjection,
        });

        expect(result.prompt).toContain('must be exactly one of:');
        expect(result.prompt).toContain('AWAITING_APPROVAL, BLOCKED, FAILED');
        expect(result.prompt).not.toContain('DONE, BLOCKED, FAILED');
        expect(result.prompt).toContain('- AWAITING_APPROVAL: the stage objective is complete');
        expect(result.prompt).not.toContain('- DONE:');
      }
    }
  });

  it('allows DONE as the success sentinel only when a template opts out of approval', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      [
        '---',
        'permissionMode: default',
        'allowedTools: Read',
        'maxTurns: 10',
        'skipApproval: true',
        '---',
        'Last line: {{sentinelList}}.',
        '{{sentinelInstructions}}',
      ].join('\n'),
      'utf8',
    );

    const result = await buildStagePrompt({
      action: 'refine',
      projection: baseProjection,
      config: {
        schemaVersion: 1,
        paths: {
          wakeRoot: '/tmp/wake',
          promptsRoot: promptsDir,
        },
        sandbox: {
          image: 'wake-sandbox',
          containerName: 'wake-sandbox',
          containerMountPath: '/wake',
          containerHomeMountPath: '/home/wake',
          extraMounts: [],
        },
        dev: {},
        scheduler: {
          intervalMs: 1000,
        },
        runner: {
          mode: 'fake',
          claude: {
            command: 'claude',
            model: 'haiku',
            smokeModel: 'haiku',
            sessionName: 'Eddy',
            remoteControlName: 'Eddy',
            smokePrompt: 'hi',
            timeoutMs: 60_000,
            remoteControl: {
              enabled: false,
            },
            models: { default: 'haiku', implement: 'claude-sonnet-4-6' },
          },
          codex: {
            command: 'codex',
            model: 'gpt-5.5',
            smokeModel: 'gpt-5.4-mini',
            smokePrompt: 'hi',
            timeoutMs: 60_000,
            models: { default: 'gpt-5.5', implement: 'gpt-5.5' },
          },
        },
        sources: {
          github: {
            enabled: false,
            repos: [],
            polling: {
              maxIssuesPerRepo: 25,
              commentPageSize: 25,
              lookbackMs: 60000,
            },
            policy: {
              requiredLabels: [],
              ignoredLabels: [],
              requiredAssignees: [],
            },
            publication: {
              postStatusComments: true,
            },
          },
        },
      },
    });

    expect(result.prompt).toContain('DONE, BLOCKED, FAILED');
    expect(result.prompt).toContain('- DONE: the stage objective is complete.');
    expect(result.prompt).not.toContain('AWAITING_APPROVAL');
  });

  it('resume prompts only surface new human comments since the last handled one, not the full history', async () => {
    const result = await buildStagePrompt({
      action: 'refine',
      mode: 'resume',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#20',
        issue: {
          repo: 'atolis-hq/wake',
          number: 20,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/20',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [
          {
            id: 'c-1',
            body: 'Already handled reply',
            author: { login: 'alice' },
            createdAt: '2026-07-05T12:01:00.000Z',
            updatedAt: '2026-07-05T12:01:00.000Z',
            isWakeAuthored: false,
            isBotAuthored: false,
          },
          {
            id: 'c-2',
            body: 'Wake status update',
            author: { login: 'eddy-bot' },
            createdAt: '2026-07-05T12:02:00.000Z',
            updatedAt: '2026-07-05T12:02:00.000Z',
            isWakeAuthored: true,
            isBotAuthored: false,
          },
          {
            id: 'c-3',
            body: 'CI comment',
            author: { login: 'ci-bot' },
            createdAt: '2026-07-05T12:03:00.000Z',
            updatedAt: '2026-07-05T12:03:00.000Z',
            isWakeAuthored: false,
            isBotAuthored: true,
          },
          {
            id: 'c-4',
            body: 'New human reply',
            author: { login: 'bob' },
            createdAt: '2026-07-05T12:04:00.000Z',
            updatedAt: '2026-07-05T12:04:00.000Z',
            isWakeAuthored: false,
            isBotAuthored: false,
          },
        ],
        wake: {
          stage: 'refined',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:04:00.000Z',
        },
        context: { lastHandledCommentId: 'c-1' },
      },
    });

    // Resume prompts must not repeat the full comment history - the session
    // already has it - only what's new since the last handled comment.
    expect(result.prompt).not.toContain('alice');
    expect(result.prompt).not.toContain('Already handled reply');
    expect(result.prompt).not.toContain('Wake status update');
    expect(result.prompt).not.toContain('CI comment');
    expect(result.prompt).toContain('bob');
    expect(result.prompt).toContain('New human reply');
  });

  it('assembles a refine-stage prompt that withholds edit tools', async () => {
    const result = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#13',
        issue: {
          repo: 'atolis-hq/wake',
          number: 13,
          title: 'Example issue',
          body: 'Please add a widget.',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/13',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
        },
        context: {},
      },
    });

    expect(result.prompt).toContain('REFINE stage');
    expect(result.prompt).toContain('Your only available tools are: Read, Glob, Grep');
    expect(result.prompt).toContain('Do not attempt to use Edit, Write, or any Bash');
    expect(result.prompt).toContain('Please add a widget.');
    expect(result.prompt).not.toContain('gh pr create');
    expect(result.permissionMode).toBe('default');
    expect(result.allowedTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash(git fetch)',
      'Bash(git status)',
    ]);
    expect(result.allowedTools).not.toContain('Edit');
  });

  it('assembles a stage prompt from an explicit prompts root when configured', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      [
        '---',
        'permissionMode: default',
        'allowedTools: Read',
        'maxTurns: 10',
        '---',
        'Custom template for {{workItemKey}}',
      ].join('\n'),
      'utf8',
    );

    const result = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#14',
        issue: {
          repo: 'atolis-hq/wake',
          number: 14,
          title: 'Example issue',
          body: 'Please add a widget.',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/14',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
        },
        context: {},
      },
      config: {
        schemaVersion: 1,
        paths: {
          wakeRoot: '/tmp/wake',
          promptsRoot: promptsDir,
        },
        sandbox: {
          image: 'wake-sandbox',
          containerName: 'wake-sandbox',
          containerMountPath: '/wake',
          containerHomeMountPath: '/home/wake',
          extraMounts: [],
        },
        dev: {},
        scheduler: {
          intervalMs: 1000,
        },
        runner: {
          mode: 'fake',
          claude: {
            command: 'claude',
            model: 'haiku',
            smokeModel: 'haiku',
            sessionName: 'Eddy',
            remoteControlName: 'Eddy',
            smokePrompt: 'hi',
            timeoutMs: 60_000,
            remoteControl: {
              enabled: false,
            },
            models: { default: 'haiku', implement: 'claude-sonnet-4-6' },
          },
          codex: {
            command: 'codex',
            model: 'gpt-5.5',
            smokeModel: 'gpt-5.4-mini',
            smokePrompt: 'hi',
            timeoutMs: 60_000,
            models: { default: 'gpt-5.5', implement: 'gpt-5.5' },
          },
        },
        sources: {
          github: {
            enabled: false,
            repos: [],
            polling: {
              maxIssuesPerRepo: 25,
              commentPageSize: 25,
              lookbackMs: 60000,
            },
            policy: {
              requiredLabels: [],
              ignoredLabels: [],
              requiredAssignees: [],
            },
            publication: {
              postStatusComments: true,
            },
          },
        },
      },
    });

    expect(result.prompt).toContain('Custom template for atolis-hq/wake#14');
    expect(result.allowedTools).toEqual(['Read']);
  });

  it('includes extraArgs verbatim before the -- terminator', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      extraArgs: ['--dangerously-skip-permissions'],
    });

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--');
    expect(args.at(-1)).toBe('do work');
  });

  it('includes allowedTools and permission-mode flags in a print invocation when requested', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash(git *)', 'Bash(gh *)'],
    });

    expect(args).toContain('--permission-mode');
    expect(args).toContain('acceptEdits');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Bash(git *) Bash(gh *)');
    expect(args).toContain('--');
    expect(args.at(-1)).toBe('do work');
  });

  it('includes a --remote-control flag with the given name and still terminates before the prompt', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      remoteControlName: 'Eddy-issue-8-run-1',
    });

    expect(args).toContain('--remote-control');
    expect(args).toContain('Eddy-issue-8-run-1');
    expect(args).toContain('--');
    expect(args.at(-1)).toBe('do work');
  });

  it('builds a session name from the ticket id, title, and run id', () => {
    const name = buildEddySessionName({
      sessionName: 'Eddy',
      issueNumber: 8,
      title: 'Update README with runner config documentation',
      runId: 'run-8-1783282434129',
    });

    expect(name).toBe(
      'Eddy-issue-8-update-readme-with-runner-config-documen-run-8-1783282434129',
    );
  });

  it('formats a run correlation log line with run and recent event ids', () => {
    const line = formatClaudeRunLogLine({
      phase: 'start',
      runId: 'run-12-1',
      action: 'implement',
      issueNumber: 12,
      repo: 'atolis-hq/wake',
      recentEventIds: ['evt-1', 'evt-2'],
      workspacePath: '/wake/workspaces/atolis-hq__wake/12',
    });

    expect(line).toContain('[claude-run]');
    expect(line).toContain('phase=start');
    expect(line).toContain('runId=run-12-1');
    expect(line).toContain('repo=atolis-hq/wake');
    expect(line).toContain('issueNumber=12');
    expect(line).toContain('action=implement');
    expect(line).toContain('recentEventIds=evt-1,evt-2');
    expect(line).toContain('workspacePath=/wake/workspaces/atolis-hq__wake/12');
  });

  it('includes a --max-turns flag when maxTurns is provided', () => {
    const args = buildClaudePrintArgs({
      model: 'haiku',
      prompt: 'do work',
      sessionName: 'Eddy',
      maxTurns: 10,
    });

    expect(args).toContain('--max-turns');
    expect(args).toContain('10');
  });

  it('reads maxTurns from the real refine and implement prompt templates', async () => {
    const refine = await buildStagePrompt({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#20',
        issue: {
          repo: 'atolis-hq/wake',
          number: 20,
          title: 'Example issue',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/20',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
        },
        context: {},
      },
    });

    expect(refine.maxTurns).toBeGreaterThan(0);
  });

  it('throws when a prompt template is missing the required maxTurns frontmatter', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'wake-prompts-'));
    await writeFile(
      join(promptsDir, 'refine.start.md'),
      ['---', 'permissionMode: default', 'allowedTools: Read', '---', 'No maxTurns here'].join(
        '\n',
      ),
      'utf8',
    );

    await expect(
      buildStagePrompt({
        action: 'refine',
        projection: {
          schemaVersion: 1,
          workItemKey: 'atolis-hq/wake#21',
          issue: {
            repo: 'atolis-hq/wake',
            number: 21,
            title: 'Example issue',
            body: 'Body',
            labels: [],
            assignees: [],
            state: 'open',
            url: 'https://example.test/issues/21',
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
          comments: [],
          wake: {
            stage: 'queue',
            stageHistory: [],
            recentEventIds: [],
            syncedAt: '2026-07-05T12:00:00.000Z',
          },
          context: {},
        },
        config: {
          schemaVersion: 1,
          paths: {
            wakeRoot: '/tmp/wake',
            promptsRoot: promptsDir,
          },
          sandbox: {
            image: 'wake-sandbox',
            containerName: 'wake-sandbox',
            containerMountPath: '/wake',
            containerHomeMountPath: '/home/wake',
            extraMounts: [],
          },
          dev: {},
          scheduler: {
            intervalMs: 1000,
          },
          runner: {
            mode: 'fake',
            claude: {
              command: 'claude',
              model: 'haiku',
              smokeModel: 'haiku',
              sessionName: 'Eddy',
              remoteControlName: 'Eddy',
              smokePrompt: 'hi',
              timeoutMs: 60_000,
              remoteControl: {
                enabled: false,
              },
              models: { default: 'haiku', implement: 'claude-sonnet-4-6' },
            },
            codex: {
              command: 'codex',
              model: 'gpt-5.5',
              smokeModel: 'gpt-5.4-mini',
              smokePrompt: 'hi',
              timeoutMs: 60_000,
              models: { default: 'gpt-5.5', implement: 'gpt-5.5' },
            },
          },
          sources: {
            github: {
              enabled: false,
              repos: [],
              polling: {
                maxIssuesPerRepo: 25,
                commentPageSize: 25,
                lookbackMs: 60000,
              },
              policy: {
                requiredLabels: [],
                ignoredLabels: [],
                requiredAssignees: [],
              },
              publication: {
                postStatusComments: true,
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/missing a required "maxTurns"/);
  });

  it('kills a hung invocation once the wall-clock timeout elapses and reports timedOut', async () => {
    const result = await runClaudeCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it('does not report a timeout for a process that finishes on its own', async () => {
    const result = await runClaudeCommand({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });
});

describe('model resolution', () => {
  function createTestConfig(overrides?: Partial<WakeConfig['runner']['claude']>): WakeConfig {
    return {
      schemaVersion: 1,
      paths: {
        wakeRoot: '/tmp/wake',
      },
      sandbox: {
        image: 'wake-sandbox',
        containerName: 'wake-sandbox',
        containerMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
        extraMounts: [],
      },
      dev: {},
      scheduler: {
        intervalMs: 1000,
      },
      runner: {
        mode: 'fake',
        claude: {
          command: 'claude',
          model: 'haiku',
          smokeModel: 'haiku',
          sessionName: 'Eddy',
          remoteControlName: 'Eddy',
          smokePrompt: 'hi',
          timeoutMs: 60_000,
          remoteControl: {
            enabled: false,
          },
          models: { default: 'haiku', implement: 'claude-sonnet-4-6' },
          ...overrides,
        },
        codex: {
          command: 'codex',
          model: 'gpt-5.5',
          smokeModel: 'gpt-5.4-mini',
          smokePrompt: 'hi',
          timeoutMs: 60_000,
          models: { default: 'gpt-5.5', implement: 'gpt-5.5' },
        },
      },
      sources: {
        github: {
          enabled: false,
          repos: [],
          polling: {
            maxIssuesPerRepo: 25,
            commentPageSize: 25,
            lookbackMs: 60000,
          },
          policy: {
            requiredLabels: [],
            ignoredLabels: [],
            requiredAssignees: [],
          },
          publication: {
            postStatusComments: true,
          },
        },
      },
    };
  }

  it('uses action-specific model when configured', () => {
    const config = createTestConfig({
      models: {
        implement: 'sonnet-4.6',
      },
    });

    const args = buildClaudePrintArgs({
      model: config.runner.claude.models?.implement ?? config.runner.claude.model,
      prompt: 'test',
      sessionName: 'Eddy',
    });

    expect(args).toContain('sonnet-4.6');
  });

  it('falls back to default model when action-specific model is not set', () => {
    const config = createTestConfig({
      models: {
        default: 'opus',
        implement: 'sonnet-4.6',
      },
    });

    // For refine action, which doesn't have a specific model configured
    const args = buildClaudePrintArgs({
      model: config.runner.claude.models?.refine ?? config.runner.claude.models?.default ?? config.runner.claude.model,
      prompt: 'test',
      sessionName: 'Eddy',
    });

    expect(args).toContain('opus');
  });

  it('falls back to legacy model field for backward compatibility', () => {
    const config = createTestConfig({
      model: 'legacy-haiku',
    });

    const args = buildClaudePrintArgs({
      model: config.runner.claude.model,
      prompt: 'test',
      sessionName: 'Eddy',
    });

    expect(args).toContain('legacy-haiku');
  });

  it('prioritizes models.default over legacy model field', () => {
    const config = createTestConfig({
      model: 'legacy-haiku',
      models: {
        default: 'new-haiku',
      },
    });

    const args = buildClaudePrintArgs({
      model: config.runner.claude.models?.default ?? config.runner.claude.model,
      prompt: 'test',
      sessionName: 'Eddy',
    });

    expect(args).toContain('new-haiku');
  });
});
