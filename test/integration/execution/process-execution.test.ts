import { describe, expect, it } from 'vitest';
import {
  claudeCommandArgs,
  cliRunner,
  codexCommandArgs,
  cursorCommandArgs,
  ExecutionCancellationReason,
} from '../../../src/execution/index.js';
import { runProcess } from '../../../src/execution/infrastructure/process-execution.js';
import { parseClaudeOutput } from '../../../src/execution/infrastructure/runners/claude.js';
import { parseCodexOutput } from '../../../src/execution/infrastructure/runners/codex.js';
import { parseCursorOutput } from '../../../src/execution/infrastructure/runners/cursor.js';

describe('runProcess', () => {
  it('terminates a child process at the configured wall-clock deadline', async () => {
    const execution = runProcess(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 5_000)'],
      undefined,
      new AbortController().signal,
      20,
    );

    await expect(execution.result).resolves.toMatchObject({ timedOut: true });
  });
});

describe('cliRunner', () => {
  it.each([
    {
      name: 'Claude',
      args: () =>
        claudeCommandArgs({
          runId: 'run-1',
          prompt: 'ship',
          model: 'claude-test',
          effort: 'medium',
          allowedTools: ['Read'],
          maxTurns: 3,
          resumeSessionId: 'prior-session',
        }),
      expected: [
        '-p',
        '--output-format',
        'json',
        '--resume',
        'prior-session',
        '--model',
        'claude-test',
        '--max-turns',
        '3',
        '--allowedTools',
        'Read',
        '--',
        'ship',
      ],
    },
    {
      name: 'Codex',
      args: () =>
        codexCommandArgs({
          runId: 'run-1',
          prompt: 'ship',
          model: 'gpt-test',
          effort: 'medium',
          allowedTools: ['Read'],
          maxTurns: 3,
          resumeSessionId: 'prior-session',
        }),
      expected: [
        'exec',
        '--json',
        '--model',
        'gpt-test',
        '-c',
        'model_reasoning_effort=medium',
        'resume',
        'prior-session',
        'ship',
      ],
    },
    {
      name: 'Cursor',
      args: () =>
        cursorCommandArgs({
          runId: 'run-1',
          prompt: 'ship',
          model: 'cursor-test',
          effort: 'medium',
          allowedTools: ['Read'],
          maxTurns: 3,
          resumeSessionId: 'prior-session',
        }),
      expected: [
        'agent',
        '-p',
        '--output-format',
        'json',
        '--model',
        'cursor-test',
        '--resume=prior-session',
        'ship',
      ],
    },
  ])('uses the configured $name CLI transport shape', ({ args, expected }) => {
    expect(args()).toEqual(expected);
  });

  it('omits Codex reasoning-effort configuration when no effort is requested', () => {
    expect(
      codexCommandArgs({
        runId: 'run-1',
        prompt: 'ship',
        model: 'gpt-test',
        allowedTools: [],
        resumeSessionId: 'prior-session',
      }),
    ).toEqual(['exec', '--json', '--model', 'gpt-test', 'resume', 'prior-session', 'ship']);
  });

  it('returns captured stdout and stderr detail for a non-zero process exit', async () => {
    const runner = cliRunner('test-cli', process.execPath, () => [
      '-e',
      'process.stdout.write("partial output"); process.stderr.write("diagnostic"); process.exit(7)',
    ]);
    const execution = await runner.start(
      { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toEqual({
      transport: 'failed',
      output: 'partial output',
      runner: 'test-cli',
      failure: { kind: 'process-exit', message: 'diagnostic' },
    });
  });

  it('classifies a wall-clock timeout as a runner timeout failure', async () => {
    const runner = cliRunner(
      'test-cli',
      process.execPath,
      () => ['-e', 'setTimeout(() => process.exit(0), 5_000)'],
      { timeoutMs: 20 },
    );
    const execution = await runner.start(
      { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toMatchObject({
      transport: 'failed',
      failure: { kind: ExecutionCancellationReason.Timeout },
    });
  });

  it('preserves configured passthrough arguments for every vendor transport', () => {
    const request = {
      runId: 'run-1',
      prompt: 'ship',
      model: 'test-model',
      allowedTools: [],
      resumeSessionId: 'session-1',
    };

    expect(claudeCommandArgs(request, ['--flag', 'claude'])).toContain('--flag');
    expect(codexCommandArgs(request, ['--flag', 'codex'])).toEqual(
      expect.arrayContaining(['resume', 'session-1', '--flag', 'codex']),
    );
    expect(cursorCommandArgs(request, ['--flag', 'cursor'])).toEqual(
      expect.arrayContaining(['--flag', 'cursor']),
    );
  });

  it('forwards Claude maxTurns and allowedTools using the established CLI flags', () => {
    const request = {
      runId: 'run-1',
      prompt: 'ship',
      model: 'test-model',
      allowedTools: ['Bash(git *)', 'Read'],
      maxTurns: 12,
    };

    expect(claudeCommandArgs(request)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'test-model',
      '--max-turns',
      '12',
      '--allowedTools',
      'Bash(git *) Read',
      '--',
      'ship',
    ]);
  });

  it('omits request-controlled Claude flags when their values are absent or empty', () => {
    const request = {
      runId: 'run-1',
      prompt: 'ship',
      allowedTools: [],
    };

    expect(claudeCommandArgs(request)).toEqual(['-p', '--output-format', 'json', '--', 'ship']);
  });

  it.each([
    {
      name: 'Claude',
      parse: parseClaudeOutput,
      stdout: JSON.stringify({
        result: 'claude answer',
        session_id: 'claude-session',
        usage: { input_tokens: 11, output_tokens: 13, cache_read_input_tokens: 17 },
        total_cost_usd: 0.02,
      }),
      expected: {
        output: 'claude answer',
        sessionId: 'claude-session',
        tokenUsage: { input: 11, output: 13, cacheRead: 17, costUsd: 0.02 },
      },
    },
    {
      name: 'Codex',
      parse: parseCodexOutput,
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'codex answer' },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 19, output_tokens: 23 } }),
      ].join('\n'),
      expected: {
        output: 'codex answer',
        sessionId: 'codex-session',
        tokenUsage: { input: 19, output: 23 },
      },
    },
    {
      name: 'Cursor',
      parse: parseCursorOutput,
      stdout: JSON.stringify({
        type: 'result',
        result: 'cursor answer',
        session_id: 'cursor-session',
        usage: { inputTokens: 29, outputTokens: 31, cacheReadTokens: 37, cacheWriteTokens: 41 },
      }),
      expected: {
        output: 'cursor answer',
        sessionId: 'cursor-session',
        tokenUsage: { input: 29, output: 31, cacheRead: 37, cacheWrite: 41 },
      },
    },
  ])(
    'uses $name structured output only inside its concrete adapter',
    ({ parse, stdout, expected }) => {
      expect(parse(stdout)).toEqual(expected);
    },
  );

  it.each([
    { name: 'Claude', parse: parseClaudeOutput },
    { name: 'Codex', parse: parseCodexOutput },
    { name: 'Cursor', parse: parseCursorOutput },
  ])(
    'leaves $name stdout untouched when it emits no recognizable structured result',
    ({ parse }) => {
      expect(parse('plain stdout')).toEqual({});
    },
  );

  it.each([
    {
      name: 'Claude',
      parse: parseClaudeOutput,
      partial: '{"result":"answer","usage":{"input_tokens":1}}',
      expected: { output: 'answer' },
    },
    {
      name: 'Codex',
      parse: parseCodexOutput,
      partial: '{"type":"turn.completed","usage":{"input_tokens":1}}',
      expected: {},
    },
    {
      name: 'Cursor',
      parse: parseCursorOutput,
      partial: '{"result":"answer","usage":{"inputTokens":1}}',
      expected: { output: 'answer' },
    },
  ])(
    '$name ignores null, arrays, and partial usage without manufacturing token counts',
    ({ parse, partial, expected }) => {
      expect(parse('null')).toEqual({});
      expect(parse('[]')).toEqual({});
      expect(parse(partial)).toEqual(expected);
    },
  );
});
