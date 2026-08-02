import { describe, expect, it } from 'vitest';
import {
  claudeCommandArgs,
  cliRunner,
  codexCommandArgs,
  cursorCommandArgs,
  ExecutionCancellationReason,
} from '../../../src-next/execution/index.js';
import { runProcess } from '../../../src-next/execution/infrastructure/process-execution.js';

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
      'ship',
      '--model',
      'test-model',
      '--max-turns',
      '12',
      '--allowedTools',
      'Bash(git *) Read',
    ]);
  });

  it('omits request-controlled Claude flags when their values are absent or empty', () => {
    const request = {
      runId: 'run-1',
      prompt: 'ship',
      allowedTools: [],
    };

    expect(claudeCommandArgs(request)).toEqual(['-p', 'ship']);
  });
});
