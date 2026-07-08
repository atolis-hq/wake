import { describe, expect, it } from 'vitest';

import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  extractCodexExecResult,
  formatCodexRunLogLine,
} from '../../src/adapters/codex/codex-runner.js';
import { defaultSmokePrompt } from '../../src/config/defaults.js';

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
      cwd: '/wake/workspaces/atolis-hq__wake/12',
      sandboxMode: 'workspace-write',
    });

    expect(args).toContain('workspace-write');
  });

  it('builds a resume invocation', () => {
    const args = buildCodexResumeArgs({
      sessionId: 'session-123',
    });

    expect(args).toEqual(['resume', 'session-123']);
  });

  it('formats a run correlation log line with run and recent event ids', () => {
    const line = formatCodexRunLogLine({
      phase: 'start',
      runId: 'run-12-1',
      action: 'implement',
      issueNumber: 12,
      repo: 'atolis-hq/wake',
      recentEventIds: ['evt-1', 'evt-2'],
      workspacePath: '/wake/workspaces/atolis-hq__wake/12',
    });

    expect(line).toContain('[codex-run]');
    expect(line).toContain('phase=start');
    expect(line).toContain('runId=run-12-1');
    expect(line).toContain('repo=atolis-hq/wake');
    expect(line).toContain('issueNumber=12');
    expect(line).toContain('action=implement');
    expect(line).toContain('recentEventIds=evt-1,evt-2');
    expect(line).toContain('workspacePath=/wake/workspaces/atolis-hq__wake/12');
  });
});

describe('codex runner output parsing', () => {
  it('extracts the final agent message, usage, and thread id from jsonl output', () => {
    const parsed = extractCodexExecResult([
      '{"type":"thread.started","thread_id":"thread-123"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Implemented change\\nDONE"}}',
      '{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}',
    ].join('\n'));

    expect(parsed.result).toBe('Implemented change\nDONE');
    expect(parsed.sessionId).toBe('thread-123');
    expect(parsed.tokenUsage).toEqual({ inputTokens: 24763, outputTokens: 122 });
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
