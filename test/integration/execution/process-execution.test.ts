import { describe, expect, it } from 'vitest';
import {
  classifyClaudeFailure,
  classifyCodexFailure,
  claudeCommandArgs,
  cliRunner,
  codexCommandArgs,
  cursorCommandArgs,
  ExecutionCancellationReason,
} from '../../../src/execution/index.js';
import { runProcess } from '../../../src/execution/infrastructure/process-execution.js';
import { parseClaudeOutput } from '../../../src/execution/infrastructure/runners/claude.js';
import { parseCodexOutput } from '../../../src/execution/infrastructure/runners/codex.js';
import {
  classifyCursorFailure,
  parseCursorOutput,
} from '../../../src/execution/infrastructure/runners/cursor.js';

describe('runProcess', () => {
  it('closes stdin so non-interactive CLIs do not wait for more input', async () => {
    const execution = runProcess(
      process.execPath,
      ['-e', 'process.stdin.resume(); process.stdin.once("end", () => process.exit(0));'],
      undefined,
      new AbortController().signal,
      { hardMs: 1_000 },
    );

    await expect(execution.result).resolves.toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('terminates a child process at the configured hard deadline', async () => {
    const execution = runProcess(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 5_000)'],
      undefined,
      new AbortController().signal,
      { hardMs: 20, cancellationGraceMs: 5 },
    );

    await expect(execution.result).resolves.toMatchObject({ timedOut: true, timeoutKind: 'hard' });
  });

  it('terminates a silent child at the idle deadline independently of the hard deadline', async () => {
    const execution = runProcess(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 5_000)'],
      undefined,
      new AbortController().signal,
      { idleMs: 20, hardMs: 1_000, cancellationGraceMs: 5 },
    );

    await expect(execution.result).resolves.toMatchObject({ timedOut: true, timeoutKind: 'idle' });
  });

  it('resets the idle deadline for stdout and stderr activity', async () => {
    const execution = runProcess(
      process.execPath,
      [
        '-e',
        'let count = 0; const interval = setInterval(() => { (count++ % 2 ? process.stdout : process.stderr).write("activity"); if (count === 6) { clearInterval(interval); process.exit(0); } }, 30)',
      ],
      undefined,
      new AbortController().signal,
      { idleMs: 120, hardMs: 1_500, cancellationGraceMs: 5 },
    );

    await expect(execution.result).resolves.toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('escalates from SIGTERM to SIGKILL after the cancellation grace period', async () => {
    const execution = runProcess(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => process.stdout.write("terminated")); setInterval(() => {}, 1_000)',
      ],
      undefined,
      new AbortController().signal,
      { cancellationGraceMs: 30 },
    );
    const started = Date.now();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await execution.cancel();
    await expect(execution.result).resolves.toMatchObject({ timedOut: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('classifies output beyond the capture budget without retaining it all in the resident', async () => {
    const execution = runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
      undefined,
      new AbortController().signal,
      { hardMs: 1_000 },
    );

    await expect(execution.result).resolves.toMatchObject({ failureKind: 'output-limit' });
  });

  it('counts continuously emitted UTF-8 output by bytes before retaining it', async () => {
    const execution = runProcess(
      process.execPath,
      [
        '-e',
        [
          'let remaining = 400_000;',
          'const write = () => {',
          '  if (remaining-- === 0) return process.exit(0);',
          "  if (!process.stdout.write('€'.repeat(4))) process.stdout.once('drain', write);",
          '  else setImmediate(write);',
          '};',
          'write();',
        ].join(''),
      ],
      undefined,
      new AbortController().signal,
      { hardMs: 5_000 },
    );

    await expect(execution.result).resolves.toMatchObject({ failureKind: 'output-limit' });
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
        '--effort',
        'medium',
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
          workspacePath: '/workspace',
          workspaceMode: 'read-only',
          resumeSessionId: 'prior-session',
        }),
      expected: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--cd',
        '/workspace',
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
        '--trust',
        '--force',
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
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'gpt-test',
      'resume',
      'prior-session',
      'ship',
    ]);
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

  it('classifies a process failure using the supplied classifier before falling back to process-exit', async () => {
    const runner = cliRunner(
      'test-cli',
      process.execPath,
      () => [
        '-e',
        'process.stdout.write("stdout text"); process.stderr.write("stderr text"); process.exit(7)',
      ],
      {
        classifyFailure: ({ stdout, stderr }) =>
          stdout.includes('stdout text') || stderr.includes('stderr text')
            ? { kind: 'provider-quota-exceeded', message: 'classified quota message' }
            : undefined,
      },
    );
    const execution = await runner.start(
      { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
      new AbortController().signal,
    );
    await expect(execution.result).resolves.toMatchObject({
      transport: 'failed',
      failure: { kind: 'provider-quota-exceeded', message: 'classified quota message' },
    });
  });

  it('falls back to process-exit when the classifier does not recognize the failure', async () => {
    const runner = cliRunner(
      'test-cli',
      process.execPath,
      () => [
        '-e',
        'process.stdout.write("stdout text"); process.stderr.write("stderr text"); process.exit(7)',
      ],
      { classifyFailure: () => undefined },
    );
    const execution = await runner.start(
      { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
      new AbortController().signal,
    );
    await expect(execution.result).resolves.toMatchObject({
      transport: 'failed',
      failure: { kind: 'process-exit' },
    });
  });

  it('classifies a wall-clock timeout as a runner timeout failure', async () => {
    const runner = cliRunner(
      'test-cli',
      process.execPath,
      () => ['-e', 'setTimeout(() => process.exit(0), 5_000)'],
      { runnerTimeouts: { hardMs: 20, cancellationGraceMs: 5 } },
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

  it('classifies an idle timeout separately from the hard timeout', async () => {
    const runner = cliRunner(
      'test-cli',
      process.execPath,
      () => ['-e', 'setTimeout(() => process.exit(0), 5_000)'],
      { runnerTimeouts: { idleMs: 20, hardMs: 1_000, cancellationGraceMs: 5 } },
    );
    const execution = await runner.start(
      { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toMatchObject({
      transport: 'failed',
      failure: { kind: ExecutionCancellationReason.IdleTimeout },
    });
  });

  it('maps a missing command to a typed process-exit failure', async () => {
    const runner = cliRunner('missing-cli', 'wake-command-that-does-not-exist', () => []);
    const execution = await runner.start(
      { runId: 'run-1', prompt: 'ignored', allowedTools: [] },
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toMatchObject({
      transport: 'failed',
      runner: 'missing-cli',
      failure: { kind: 'process-exit', message: expect.any(String) },
    });
  });

  it('keeps Claude invocation usage unchanged when shared parser plumbing receives a baseline', async () => {
    const stdout = JSON.stringify({
      result: 'claude answer',
      usage: { input_tokens: 11, output_tokens: 13, cache_read_input_tokens: 17 },
      total_cost_usd: 0.02,
    });
    const runner = cliRunner(
      'claude',
      process.execPath,
      () => ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
      { parseSuccessfulOutput: parseClaudeOutput },
    );
    const execution = await runner.start(
      {
        runId: 'run-1',
        prompt: 'ignored',
        allowedTools: [],
        usageBaseline: { input: 1_000, output: 2_000, cacheRead: 3_000 },
      },
      new AbortController().signal,
    );

    await expect(execution.result).resolves.toMatchObject({
      tokenUsage: { input: 11, output: 13, cacheRead: 17, costUsd: 0.02 },
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

  it('uses configured runner model and effort when an agent request does not override them', () => {
    const request = { runId: 'run-1', prompt: 'ship', allowedTools: [] };

    expect(claudeCommandArgs(request, [], { model: 'claude-default', effort: 'high' })).toEqual(
      expect.arrayContaining(['--model', 'claude-default', '--effort', 'high']),
    );
    expect(codexCommandArgs(request, [], { model: 'gpt-default', effort: 'medium' })).toEqual(
      expect.arrayContaining(['--model', 'gpt-default', '-c', 'model_reasoning_effort=medium']),
    );
    expect(cursorCommandArgs(request, [], { model: 'cursor-default' })).toEqual(
      expect.arrayContaining(['--model', 'cursor-default']),
    );
  });

  it('maps Wake workspace modes to Codex sandbox modes', () => {
    const request = {
      runId: 'run-1',
      prompt: 'ship',
      allowedTools: [],
      workspacePath: '/workspace',
    };

    expect(codexCommandArgs({ ...request, workspaceMode: 'read-only' })).toEqual(
      expect.arrayContaining(['--sandbox', 'workspace-write', '--cd', '/workspace']),
    );
    expect(codexCommandArgs({ ...request, workspaceMode: 'branch' })).toEqual(
      expect.arrayContaining(['--sandbox', 'danger-full-access', '--cd', '/workspace']),
    );
  });

  it('uses Cursor trust mode with the legacy workspace permission policy', () => {
    const request = { runId: 'run-1', prompt: 'ship', allowedTools: [] };

    expect(cursorCommandArgs({ ...request, workspaceMode: 'read-only' })).toEqual(
      expect.arrayContaining(['--trust', '--mode', 'ask']),
    );
    expect(cursorCommandArgs({ ...request, workspaceMode: 'branch' })).toEqual(
      expect.arrayContaining(['--trust', '--force']),
    );
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

  it('uses the final Codex turn usage snapshot instead of summing snapshots', () => {
    const stdout = [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 19, output_tokens: 23 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 29, output_tokens: 31 } }),
    ].join('\n');

    expect(parseCodexOutput(stdout)).toEqual({ tokenUsage: { input: 29, output: 31 } });
  });

  it('subtracts the resumed Codex usage baseline from the final cumulative snapshot', () => {
    const stdout = JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 29,
        output_tokens: 31,
        input_tokens_details: { cached_tokens: 37, cache_creation_tokens: 41 },
      },
    });
    const request = {
      runId: 'run-1',
      prompt: 'ship',
      allowedTools: [],
      usageBaseline: { input: 19, output: 23, cacheRead: 29, cacheWrite: 31 },
    };

    expect(parseCodexOutput(stdout, request)).toEqual({
      tokenUsage: { input: 10, output: 8, cacheRead: 8, cacheWrite: 10 },
    });
  });

  it('reports the final Codex usage snapshot when resume history cannot provide a safe baseline', () => {
    const stdout = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 29, output_tokens: 31 },
    });
    const request = { runId: 'run-1', prompt: 'ship', allowedTools: [] };

    expect(parseCodexOutput(stdout, request)).toEqual({ tokenUsage: { input: 29, output: 31 } });
  });

  it.each([
    {
      name: 'a negative delta',
      usage: { input_tokens: 18, output_tokens: 31, input_tokens_details: { cached_tokens: 37 } },
      baseline: { input: 19, output: 23, cacheRead: 29 },
    },
    {
      name: 'a missing cache counter that exists in the baseline',
      usage: { input_tokens: 29, output_tokens: 31 },
      baseline: { input: 19, output: 23, cacheRead: 29 },
    },
    {
      name: 'a negative baseline counter',
      usage: { input_tokens: 29, output_tokens: 31 },
      baseline: { input: -10, output: 23 },
    },
  ])('omits Codex token usage for $name', ({ usage, baseline }) => {
    const request = { runId: 'run-1', prompt: 'ship', allowedTools: [], usageBaseline: baseline };

    expect(parseCodexOutput(JSON.stringify({ type: 'turn.completed', usage }), request)).toEqual(
      {},
    );
  });

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

  it('classifies a Codex usage-limit turn.failed event as provider-quota-exceeded', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'error',
        message:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:17 AM.",
      }),
      JSON.stringify({
        type: 'turn.failed',
        error: {
          message:
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:17 AM.",
        },
      }),
    ].join('\n');

    expect(classifyCodexFailure({ stdout, stderr: '' })).toEqual({
      kind: 'provider-quota-exceeded',
      message:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:17 AM.",
    });
  });

  it('does not classify an ordinary Codex crash as quota-exceeded', () => {
    expect(classifyCodexFailure({ stdout: '', stderr: 'Segmentation fault' })).toBeUndefined();
  });

  it('does not classify a Codex auth failure as quota-exceeded', () => {
    const stdout = JSON.stringify({
      type: 'error',
      message: 'Unauthorized: authentication failed, please run `codex login`.',
    });
    expect(classifyCodexFailure({ stdout, stderr: '' })).toBeUndefined();
  });

  it('does not scan raw stdout when no structured error/turn.failed event is present', () => {
    // The word "quota" appears in this agent-generated line, but it is not a
    // structured Codex error event, so it must never be classified as quota.
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'I updated the quota-check middleware and committed.' },
    });
    expect(classifyCodexFailure({ stdout, stderr: '' })).toBeUndefined();
  });

  it('classifies a Claude rate-limit message as provider-quota-exceeded', () => {
    expect(
      classifyClaudeFailure({
        stdout: '',
        stderr: 'Error: You have exceeded your rate limit. Please try again later.',
      }),
    ).toEqual({
      kind: 'provider-quota-exceeded',
      message: 'Error: You have exceeded your rate limit. Please try again later.',
    });
  });

  it('does not classify an ordinary Claude crash as quota-exceeded', () => {
    expect(
      classifyClaudeFailure({ stdout: '', stderr: 'ENOENT: command not found' }),
    ).toBeUndefined();
  });

  it('does not classify a Claude auth failure as quota-exceeded', () => {
    expect(
      classifyClaudeFailure({
        stdout: '',
        stderr: 'Error: Unauthorized. Please run `claude login`.',
      }),
    ).toBeUndefined();
  });

  it('does not scan Claude stdout when stderr already carries diagnostic text', () => {
    // stdout here is agent-generated content that happens to contain "quota";
    // since stderr is non-empty it must be the only text classified against.
    expect(
      classifyClaudeFailure({
        stdout: 'I updated the quota-check middleware and committed.',
        stderr: 'ENOENT: command not found',
      }),
    ).toBeUndefined();
  });

  it('classifies a Cursor quota message as provider-quota-exceeded', () => {
    expect(
      classifyCursorFailure({ stdout: 'You have exceeded your monthly quota.', stderr: '' }),
    ).toEqual({
      kind: 'provider-quota-exceeded',
      message: 'You have exceeded your monthly quota.',
    });
  });

  it('does not classify an ordinary Cursor crash as quota-exceeded', () => {
    expect(classifyCursorFailure({ stdout: '', stderr: 'panic: runtime error' })).toBeUndefined();
  });

  it('does not classify a Cursor auth failure as quota-exceeded', () => {
    expect(
      classifyCursorFailure({ stdout: '', stderr: 'Error: unauthorized. Invalid API key.' }),
    ).toBeUndefined();
  });

  it('does not scan Cursor stdout when stderr already carries diagnostic text', () => {
    expect(
      classifyCursorFailure({
        stdout: 'You have exceeded your monthly quota.',
        stderr: 'panic: runtime error',
      }),
    ).toBeUndefined();
  });
});
