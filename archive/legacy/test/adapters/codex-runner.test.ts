import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

import { describe, expect, it } from 'vitest';

import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  buildCodexToolCapabilityNote,
  classifyCodexCliFailure,
  createCodexRunner,
  extractCodexErrorMessage,
  extractCodexExecResult,
  formatCodexRunLogLine,
} from '../../src/adapters/codex/codex-runner.js';
import { createDefaultWakeConfig, defaultSmokePrompt } from '../../src/config/defaults.js';

const baseProjection = {
  schemaVersion: 1 as const,
  workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A12',
  issue: {
    repo: 'atolis-hq/wake',
    number: 12,
    title: 'Example issue',
    body: 'Body',
    labels: ['wake:implement'],
    assignees: [],
    isPullRequest: false,
    state: 'open' as const,
    url: 'https://example.test/issues/12',
    createdAt: '2026-07-05T12:00:00.000Z',
    updatedAt: '2026-07-05T12:00:00.000Z',
  },
  comments: [],
  wake: {
    stage: 'implement' as const,
    stageHistory: [],
    recentEventIds: [],
    syncedAt: '2026-07-05T12:00:00.000Z',
    expectedEcho: { commentIds: [], labels: [] },
  },
  context: {},
  correlatedResources: [],
};

describe('codex runner command building', () => {
  it('builds a minimal json exec invocation for smoke tests', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.4-mini',
      prompt: defaultSmokePrompt,
      cwd: '/wake/workspaces/atolis-hq__wake/12',
      sandboxMode: 'danger-full-access',
    });

    expect(args[0]).toBe('--ask-for-approval');
    expect(args[1]).toBe('never');
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--sandbox');
    expect(args).toContain('danger-full-access');
    expect(args).toContain('--cd');
    expect(args).toContain('/wake/workspaces/atolis-hq__wake/12');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });

  it('builds a workspace-write invocation for planning-style stages', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.5',
      prompt: 'plan it',
      harnessPrompt: 'Wake harness',
      cwd: '/wake/workspaces/atolis-hq__wake/12',
      sandboxMode: 'workspace-write',
    });

    expect(args).toContain('workspace-write');
    expect(args.at(-1)).toBe('Wake harness\n\nplan it');
  });

  it('builds a resume invocation', () => {
    const args = buildCodexResumeArgs({
      model: 'gpt-5.5',
      prompt: 'continue',
      cwd: '/wake/workspaces/atolis-hq__wake/12',
      sandboxMode: 'workspace-write',
      sessionId: 'session-123',
    });

    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--cd');
    expect(args).toContain('/wake/workspaces/atolis-hq__wake/12');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args.slice(-3)).toEqual(['resume', 'session-123', 'continue']);
  });

  it('formats a run correlation log line with run and recent event ids', () => {
    const line = formatCodexRunLogLine({
      phase: 'start',
      runId: 'run-12-1',
      action: 'implement',
      issueNumber: 12,
      repo: 'atolis-hq/wake',
      recentEventIds: ['evt-1', 'evt-2'],
      model: 'gpt-5.5',
      workspacePath: '/wake/workspaces/atolis-hq__wake/12',
    });

    expect(line).toContain('[codex-run]');
    expect(line).toContain('phase=start');
    expect(line).toContain('cli=Codex');
    expect(line).toContain('model=gpt-5.5');
    expect(line).toContain('runId=run-12-1');
    expect(line).toContain('repo=atolis-hq/wake');
    expect(line).toContain('issueNumber=12');
    expect(line).toContain('action=implement');
    expect(line).toContain('recentEventIds=evt-1,evt-2');
    expect(line).toContain('workspacePath=/wake/workspaces/atolis-hq__wake/12');
  });
});

describe('codex runner session resume', () => {
  it.skipIf(platform === 'win32')(
    'resumes a prior Codex session with codex exec resume and the stage prompt',
    async () => {
      const commandDir = await mkdtemp(join(tmpdir(), 'wake-codex-cli-'));
      const command = join(commandDir, 'codex-success');
      const argsFile = join(commandDir, 'args.txt');
      await writeFile(
        command,
        [
          '#!/usr/bin/env bash',
          `printf '%s\\n' "$@" > '${argsFile}'`,
          'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"session-codex-123"}\'',
          'printf \'%s\\n\' \'{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done\\n```wake-result\\n{\\"status\\":\\"AWAITING_APPROVAL\\"}\\n```\\nAWAITING_APPROVAL"}}\'',
          'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\'',
        ].join('\n'),
        'utf8',
      );
      await chmod(command, 0o755);

      const runner = createCodexRunner({
        command,
        cwd: process.cwd(),
        settings: {
          command,
          model: 'gpt-5.5',
          smokeModel: 'gpt-5.5-mini',
          smokePrompt: defaultSmokePrompt,
          timeoutMs: 10_000,
        },
      });

      const result = await runner.run({
        action: 'implement',
        projection: {
          ...baseProjection,
          wake: {
            ...baseProjection.wake,
            sessionId: 'session-codex-123',
            sessionCli: 'Codex',
          },
        },
        recentEvents: [],
        config: createDefaultWakeConfig(process.cwd()),
        runId: 'run-12-codex-resume',
        workspacePath: process.cwd(),
        workspaceMode: 'branch',
      });

      const recordedArgs = await readFile(argsFile, 'utf8');
      const args = recordedArgs.trim().split('\n');
      const resumeIndex = args.indexOf('resume');
      expect(args).toContain('exec');
      expect(args).toContain('--json');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).toContain('--sandbox');
      expect(args).toContain('danger-full-access');
      expect(args).toContain('--cd');
      expect(args).toContain(process.cwd());
      expect(resumeIndex).toBeGreaterThan(-1);
      expect(args[resumeIndex + 1]).toBe('session-codex-123');
      expect(recordedArgs).toContain('IMPLEMENT stage');
      expect(result.session_id).toBe('session-codex-123');
    },
  );
});

describe('codex tool capability note', () => {
  it('returns a shell-oriented note for read-only stages', () => {
    const note = buildCodexToolCapabilityNote({ workspaceMode: 'read-only', mode: 'start' });

    expect(note).toBeDefined();
    // Should mention shell commands, not Claude Code tool names
    expect(note).toContain('cat');
    expect(note).toContain('grep');
    expect(note).toContain('git status');
    expect(note).toContain('sandbox');
    // Must not mention Claude-specific tool names
    expect(note).not.toContain('Read,');
    expect(note).not.toContain('Glob');
  });

  it('prefixes the resume note with a planning-stage reminder', () => {
    const start = buildCodexToolCapabilityNote({ workspaceMode: 'read-only', mode: 'start' });
    const resume = buildCodexToolCapabilityNote({ workspaceMode: 'read-only', mode: 'resume' });

    expect(resume).toContain('planning-only stage');
    expect(resume).toContain(start!.slice(0, 30));
  });

  it('returns undefined outside read-only stages so the default note is used', () => {
    const note = buildCodexToolCapabilityNote({ workspaceMode: 'branch', mode: 'start' });

    expect(note).toBeUndefined();
  });
});

describe('codex runner output parsing', () => {
  it('extracts the final agent message, usage, and thread id from jsonl output', () => {
    const parsed = extractCodexExecResult(
      [
        '{"type":"thread.started","thread_id":"thread-123"}',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Implemented change\\nDONE"}}',
        '{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}',
      ].join('\n'),
    );

    expect(parsed.result).toBe('Implemented change\nDONE');
    expect(parsed.sessionId).toBe('thread-123');
    expect(parsed.tokenUsage).toEqual({ inputTokens: 24763, outputTokens: 122, turns: 1 });
  });

  it('accumulates usage across multiple turn.completed events instead of keeping only the last', () => {
    const parsed = extractCodexExecResult(
      [
        '{"type":"thread.started","thread_id":"thread-123"}',
        '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
        '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}',
        '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"DONE"}}',
      ].join('\n'),
    );

    expect(parsed.tokenUsage).toEqual({ inputTokens: 150, outputTokens: 15, turns: 2 });
  });

  it('throws when the jsonl stream does not include a final agent message', () => {
    expect(() =>
      extractCodexExecResult(
        ['{"type":"thread.started","thread_id":"thread-123"}', '{"type":"turn.completed"}'].join(
          '\n',
        ),
      ),
    ).toThrow(/final agent message/i);
  });
});

describe('codex runner failure classification', () => {
  // Captured from a real `codex exec` invocation against an exhausted ChatGPT
  // Codex plan quota.
  const quotaStdout = [
    '{"type":"thread.started","thread_id":"019f50d8-44de-7343-b518-5a99341d7173"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:29 PM."}',
    '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:29 PM."}}',
  ].join('\n');

  it('extracts the structured error message from a quota-exhausted jsonl stream', () => {
    expect(extractCodexErrorMessage(quotaStdout)).toBe(
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:29 PM.",
    );
  });

  it('classifies a usage-limit jsonl error as quota', () => {
    expect(classifyCodexCliFailure({ stdout: quotaStdout, stderr: '', timedOut: false })).toBe(
      'quota',
    );
  });

  it('classifies a timeout as infra even if the stream happens to mention quota wording', () => {
    expect(classifyCodexCliFailure({ stdout: quotaStdout, stderr: '', timedOut: true })).toBe(
      'infra',
    );
  });

  it('classifies missing Codex authentication as infra instead of quota', () => {
    const authStdout = [
      '{"type":"thread.started","thread_id":"019f96c3-922a-77b3-90eb-82665a0eeff4"}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, request id: 493d40f4-90bd-43c6-a52c-b08df77799d1)"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, request id: 4cf4afde-e359-48db-8403-8e8e4308a8b8"}}',
    ].join('\n');

    expect(classifyCodexCliFailure({ stdout: authStdout, stderr: '', timedOut: false })).toBe(
      'infra',
    );
  });

  it.each(['missing authentication', 'not logged in', 'login required'])(
    'preserves auth exhaustion as quota for "%s"',
    (message) => {
      const authStdout = [
        '{"type":"thread.started","thread_id":"thread-auth-expired"}',
        '{"type":"turn.started"}',
        JSON.stringify({ type: 'error', message }),
        JSON.stringify({ type: 'turn.failed', error: { message } }),
      ].join('\n');

      expect(classifyCodexCliFailure({ stdout: authStdout, stderr: '', timedOut: false })).toBe(
        'quota',
      );
    },
  );

  it('classifies an unrecognized failure as infra', () => {
    expect(
      classifyCodexCliFailure({
        stdout: '{"type":"error","message":"internal server error"}',
        stderr: '',
        timedOut: false,
      }),
    ).toBe('infra');
  });
});
