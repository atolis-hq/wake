import { describe, expect, it } from 'vitest';

import {
  buildCursorAgentArgs,
  buildCursorResumeArgs,
  buildCursorToolCapabilityNote,
  classifyCursorCliFailure,
  extractCursorAgentResult,
  formatCursorRunLogLine,
} from '../../src/adapters/cursor/cursor-runner.js';
import { defaultSmokePrompt } from '../../src/config/defaults.js';

describe('cursor runner command building', () => {
  it('builds a minimal json agent invocation for smoke tests', () => {
    const args = buildCursorAgentArgs({
      model: 'claude-haiku-4-5',
      prompt: defaultSmokePrompt,
      force: true,
    });

    expect(args[0]).toBe('agent');
    expect(args[1]).toBe('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--model');
    expect(args).toContain('claude-haiku-4-5');
    expect(args).not.toContain('--mode');
    expect(args).toContain('--force');
    expect(args.at(-1)).toBe(defaultSmokePrompt);
  });

  it('builds a read-only ask-mode invocation for refine stages', () => {
    const args = buildCursorAgentArgs({
      model: 'claude-sonnet-4-6',
      prompt: 'plan it',
      harnessPrompt: 'Wake harness',
      mode: 'ask',
    });

    expect(args).toContain('--mode');
    expect(args).toContain('ask');
    expect(args).not.toContain('--force');
    expect(args.at(-1)).toBe('Wake harness\n\nplan it');
  });

  it('builds a resume invocation with the session id as --resume flag', () => {
    const args = buildCursorAgentArgs({
      model: 'claude-sonnet-4-6',
      prompt: 'continue',
      force: true,
      resumeSessionId: 'session-abc-123',
    });

    expect(args).toContain('--resume=session-abc-123');
  });

  it('builds a standalone resume args array', () => {
    const args = buildCursorResumeArgs({ sessionId: 'session-abc-123' });

    expect(args).toEqual(['agent', '--resume=session-abc-123']);
  });

  it('formats a run correlation log line with run and recent event ids', () => {
    const line = formatCursorRunLogLine({
      phase: 'start',
      runId: 'run-12-1',
      action: 'implement',
      issueNumber: 12,
      repo: 'atolis-hq/wake',
      recentEventIds: ['evt-1', 'evt-2'],
      model: 'claude-sonnet-4-6',
      workspacePath: '/wake/workspaces/atolis-hq__wake/12',
    });

    expect(line).toContain('[cursor-run]');
    expect(line).toContain('phase=start');
    expect(line).toContain('cli=Cursor');
    expect(line).toContain('model=claude-sonnet-4-6');
    expect(line).toContain('runId=run-12-1');
    expect(line).toContain('repo=atolis-hq/wake');
    expect(line).toContain('issueNumber=12');
    expect(line).toContain('action=implement');
    expect(line).toContain('recentEventIds=evt-1,evt-2');
    expect(line).toContain('workspacePath=/wake/workspaces/atolis-hq__wake/12');
  });
});

describe('cursor tool capability note', () => {
  it('returns a read-only ask-mode note for read-only stages', () => {
    const note = buildCursorToolCapabilityNote({ workspaceMode: 'read-only', mode: 'start' });

    expect(note).toBeDefined();
    expect(note).toContain('read-only');
    expect(note).toContain('ask mode');
    expect(note).not.toContain('--force');
  });

  it('prefixes the resume note with a planning-stage reminder', () => {
    const start = buildCursorToolCapabilityNote({ workspaceMode: 'read-only', mode: 'start' });
    const resume = buildCursorToolCapabilityNote({ workspaceMode: 'read-only', mode: 'resume' });

    expect(resume).toContain('planning-only stage');
    expect(resume).toContain(start!.slice(0, 30));
  });

  it('returns undefined outside read-only stages so the default note is used', () => {
    const note = buildCursorToolCapabilityNote({ workspaceMode: 'branch', mode: 'start' });

    expect(note).toBeUndefined();
  });
});

describe('cursor runner output parsing', () => {
  it('extracts the result and session_id from a success JSON response', () => {
    const parsed = extractCursorAgentResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1234,
        result: 'Implemented the change\nDONE',
        session_id: 'cursor-session-123',
      }),
    );

    expect(parsed.result).toBe('Implemented the change\nDONE');
    expect(parsed.sessionId).toBe('cursor-session-123');
    expect(parsed.isError).toBe(false);
  });

  it('extracts result without session_id when not present', () => {
    const parsed = extractCursorAgentResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Analysis complete\nDONE',
      }),
    );

    expect(parsed.result).toBe('Analysis complete\nDONE');
    expect(parsed.sessionId).toBeUndefined();
  });

  it("extracts token usage using Cursor's camelCase usage keys (#135)", () => {
    // Captured from a real `cursor-agent agent -p --output-format json` call
    // run via the wake-sandbox container.
    const parsed = extractCursorAgentResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 4357,
        result: 'hi',
        session_id: 'c4860a32-d60b-49c5-9149-ca2bd956e5ef',
        usage: { inputTokens: 5945, outputTokens: 32, cacheReadTokens: 6020, cacheWriteTokens: 0 },
      }),
    );

    expect(parsed.tokenUsage).toEqual({
      inputTokens: 5945,
      outputTokens: 32,
      cacheReadInputTokens: 6020,
      cacheCreationInputTokens: 0,
    });
  });

  it('throws when the output is empty', () => {
    expect(() => extractCursorAgentResult('')).toThrow(/no output/i);
  });

  it('throws when the JSON output has no result field', () => {
    expect(() =>
      extractCursorAgentResult(JSON.stringify({ type: 'result', is_error: false })),
    ).toThrow(/result field/i);
  });
});

describe('cursor failure classification', () => {
  it('classifies timed-out runs as infra failures', () => {
    const cls = classifyCursorCliFailure({ stderr: '', stdout: '', timedOut: true });
    expect(cls).toBe('infra');
  });

  it('classifies is_error=true from JSON as task failures', () => {
    const cls = classifyCursorCliFailure({
      stderr: '',
      stdout: '',
      timedOut: false,
      isError: true,
    });
    expect(cls).toBe('task');
  });

  it('classifies rate-limit errors as quota failures', () => {
    const cls = classifyCursorCliFailure({
      stderr: 'Error: rate limit exceeded',
      stdout: '',
      timedOut: false,
    });
    expect(cls).toBe('quota');
  });

  it('classifies Cursor usage-limit errors as quota failures', () => {
    const cls = classifyCursorCliFailure({
      stderr:
        "ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.",
      stdout: '',
      timedOut: false,
    });
    expect(cls).toBe('quota');
  });

  it('classifies authentication errors as quota failures', () => {
    const cls = classifyCursorCliFailure({
      stderr: 'Unauthorized: invalid api key',
      stdout: '',
      timedOut: false,
    });
    expect(cls).toBe('quota');
  });

  it('classifies unknown errors as infra failures', () => {
    const cls = classifyCursorCliFailure({
      stderr: 'Segmentation fault',
      stdout: '',
      timedOut: false,
    });
    expect(cls).toBe('infra');
  });
});
