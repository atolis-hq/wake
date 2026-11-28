import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cliRunner,
  ExecutionCancellationReason,
  type RunnerRequest,
} from '../../../src/execution/index.js';

const request: RunnerRequest = { runId: 'run-1', prompt: 'ignored', allowedTools: [] };
const signal = () => new AbortController().signal;
const script = (source: string) => () => ['-e', source];
const stdoutScript = (text: string) => script(`process.stdout.write(${JSON.stringify(text)})`);

async function settle(runner: ReturnType<typeof cliRunner>, input = request) {
  return (await runner.start(input, signal())).result;
}

describe('cliRunner success mapping', () => {
  it('reports raw stdout as the output of a clean exit', async () => {
    const result = await settle(cliRunner('test-cli', process.execPath, stdoutScript('hello')));

    expect(result).toEqual({ transport: 'succeeded', output: 'hello', runner: 'test-cli' });
  });

  it('echoes the requested model, falling back to the runner default', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('ok'), {
      defaultModel: 'default-model',
    });

    await expect(settle(runner)).resolves.toMatchObject({ model: 'default-model' });
    await expect(settle(runner, { ...request, model: 'asked-model' })).resolves.toMatchObject({
      model: 'asked-model',
    });
  });

  it('omits the model when neither the request nor the runner names one', async () => {
    const result = await settle(cliRunner('test-cli', process.execPath, stdoutScript('ok')));

    expect(result).not.toHaveProperty('model');
  });

  it('lets parsed fields replace the raw output and passes stdout and request to the parser', async () => {
    const seen: unknown[] = [];
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      parseSuccessfulOutput: (stdout, input) => {
        seen.push(stdout, input.runId);
        return { output: 'parsed', sessionId: 'session-1' };
      },
    });

    await expect(settle(runner)).resolves.toEqual({
      transport: 'succeeded',
      output: 'parsed',
      runner: 'test-cli',
      sessionId: 'session-1',
    });
    expect(seen).toEqual(['raw', 'run-1']);
  });

  it('swallows a parser exception and keeps the raw output', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      parseSuccessfulOutput: () => {
        throw new Error('parser blew up');
      },
    });

    await expect(settle(runner)).resolves.toEqual({
      transport: 'succeeded',
      output: 'raw',
      runner: 'test-cli',
    });
  });
});

describe('cliRunner unparsed and rejected exits', () => {
  const unparsedSuccessFailure = { kind: 'test-unparsed', message: 'no usable result' };

  it('fails an exit-zero run whose parser yields no output when the adapter requires one', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      parseSuccessfulOutput: () => ({ sessionId: 'session-1' }),
      unparsedSuccessFailure,
    });

    await expect(settle(runner)).resolves.toEqual({
      transport: 'failed',
      output: '',
      runner: 'test-cli',
      failure: unparsedSuccessFailure,
    });
  });

  it('treats a throwing parser as unparsed when the adapter requires an output', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      parseSuccessfulOutput: () => {
        throw new Error('parser blew up');
      },
      unparsedSuccessFailure,
    });

    await expect(settle(runner)).resolves.toMatchObject({
      transport: 'failed',
      failure: unparsedSuccessFailure,
    });
  });

  it('accepts an exit-zero run whose parser yields an output even when one is required', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      parseSuccessfulOutput: () => ({ output: 'parsed' }),
      unparsedSuccessFailure,
    });

    await expect(settle(runner)).resolves.toMatchObject({
      transport: 'succeeded',
      output: 'parsed',
    });
  });

  it('requires no output from the parser unless the adapter asks for it', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      parseSuccessfulOutput: () => ({}),
    });

    await expect(settle(runner)).resolves.toMatchObject({
      transport: 'succeeded',
      output: 'raw',
    });
  });

  it('continues to parsing when the rejection check finds nothing, passing it stdout and request', async () => {
    const seen: unknown[] = [];
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      rejectSuccessfulExit: (stdout, input) => {
        seen.push(stdout, input.runId);
        return undefined;
      },
      parseSuccessfulOutput: () => ({ output: 'parsed' }),
    });

    await expect(settle(runner)).resolves.toMatchObject({ output: 'parsed' });
    expect(seen).toEqual(['raw', 'run-1']);
  });

  it('does not run the rejection check or parser for a failed exit', async () => {
    const calls: string[] = [];
    const runner = cliRunner('test-cli', process.execPath, script('process.exit(3)'), {
      rejectSuccessfulExit: () => {
        calls.push('reject');
        return undefined;
      },
      parseSuccessfulOutput: () => {
        calls.push('parse');
        return {};
      },
    });

    await expect(settle(runner)).resolves.toMatchObject({ transport: 'failed' });
    expect(calls).toEqual([]);
  });
});

describe('cliRunner failure mapping', () => {
  it('falls back to the exit code when standard error is empty', async () => {
    const runner = cliRunner('test-cli', process.execPath, script('process.exit(5)'));

    await expect(settle(runner)).resolves.toMatchObject({
      failure: { kind: 'process-exit', message: 'exit 5' },
    });
  });

  it('names the configured idle and hard timeouts in the failure message', async () => {
    const hard = cliRunner('test-cli', process.execPath, script('setTimeout(() => {}, 5_000)'), {
      runnerTimeouts: { hardMs: 20, cancellationGraceMs: 5 },
    });
    const idle = cliRunner('test-cli', process.execPath, script('setTimeout(() => {}, 5_000)'), {
      runnerTimeouts: { idleMs: 20, hardMs: 1_000, cancellationGraceMs: 5 },
    });

    await expect(settle(hard)).resolves.toMatchObject({
      failure: {
        kind: ExecutionCancellationReason.Timeout,
        message: 'Runner exceeded the hard timeout of 20ms',
      },
    });
    await expect(settle(idle)).resolves.toMatchObject({
      failure: {
        kind: ExecutionCancellationReason.IdleTimeout,
        message: 'Runner was idle for 20ms',
      },
    });
  });

  it('prefers the timeout over the classifier and skips the success path', async () => {
    const runner = cliRunner('test-cli', process.execPath, script('setTimeout(() => {}, 5_000)'), {
      runnerTimeouts: { hardMs: 20, cancellationGraceMs: 5 },
      classifyFailure: () => ({ kind: 'classified', message: 'must not win' }),
      parseSuccessfulOutput: () => ({ output: 'must not be used' }),
    });

    await expect(settle(runner)).resolves.toMatchObject({
      transport: 'failed',
      failure: { kind: ExecutionCancellationReason.Timeout },
    });
  });

  it('reports output beyond the capture budget as an output-limit failure', async () => {
    const runner = cliRunner(
      'test-cli',
      process.execPath,
      script('process.stdout.write("x".repeat(2 * 1024 * 1024))'),
      { runnerTimeouts: { hardMs: 5_000 }, classifyFailure: () => undefined },
    );

    await expect(settle(runner)).resolves.toMatchObject({
      transport: 'failed',
      failure: { kind: 'output-limit', message: expect.stringContaining('exceeded') },
    });
  });

  it('kills the process when the signal aborts and still resolves as a failed exit', async () => {
    const controller = new AbortController();
    const runner = cliRunner('test-cli', process.execPath, script('setTimeout(() => {}, 5_000)'), {
      runnerTimeouts: { cancellationGraceMs: 5 },
    });
    const execution = await runner.start(request, controller.signal);
    controller.abort();

    await expect(execution.result).resolves.toMatchObject({
      transport: 'failed',
      failure: { kind: 'process-exit' },
    });
  });
});

describe('cliRunner process wiring', () => {
  it('reports a process identity, using the process identity when the platform has one', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('ok'));
    const execution = await runner.start(request, signal());
    await execution.result;

    expect(execution.identity?.kind).toBe('process');
    expect(Number.isNaN(Date.parse(execution.identity?.startedAt ?? ''))).toBe(false);
    if (process.platform === 'linux')
      expect(JSON.parse(execution.identity!.id)).toHaveProperty('pid');
    else expect(execution.identity?.id).toBe('run-1');
  });

  it('runs in the request workspace', async () => {
    const runner = cliRunner(
      'test-cli',
      process.execPath,
      script('process.stdout.write(process.cwd())'),
    );

    await expect(
      settle(runner, { ...request, workspacePath: process.cwd() }),
    ).resolves.toMatchObject({
      output: realpathSync(process.cwd()),
    });
  });

  it('feeds stdout through the configured decoder', async () => {
    const runner = cliRunner('test-cli', process.execPath, stdoutScript('raw'), {
      createStdoutDecoder: () => ({
        push: (chunk) => ({ output: Buffer.from(chunk.toString().toUpperCase()), activity: true }),
        finish: () => Buffer.alloc(0),
      }),
    });

    await expect(settle(runner)).resolves.toMatchObject({ output: 'RAW' });
  });

  it('notifies the request timeout hook with the timeout kind', async () => {
    const kinds: string[] = [];
    const runner = cliRunner('test-cli', process.execPath, script('setTimeout(() => {}, 5_000)'), {
      runnerTimeouts: { hardMs: 20, cancellationGraceMs: 5 },
    });

    await settle(runner, {
      ...request,
      onTimeout: async (kind) => {
        kinds.push(kind);
      },
    });
    expect(kinds).toEqual(['hard']);
  });
});

describe('cliRunner capabilities', () => {
  it('declares no resume or ephemeral MCP support unless the adapter does', () => {
    const plain = cliRunner('test-cli', process.execPath, () => []);
    const capable = cliRunner('test-cli', process.execPath, () => [], {
      supportsSessionResume: true,
      supportsEphemeralMcp: true,
    });

    expect(plain).toMatchObject({ supportsSessionResume: false, supportsEphemeralMcp: false });
    expect(capable).toMatchObject({ supportsSessionResume: true, supportsEphemeralMcp: true });
  });

  const mcpRequest: RunnerRequest = {
    ...request,
    mcpServers: [{ name: 'wake', command: 'wake' }],
  };

  it('refuses ephemeral MCP servers for a runner that does not support them', async () => {
    let spawned = false;
    const runner = cliRunner('test-cli', process.execPath, () => {
      spawned = true;
      return [];
    });

    await expect(runner.start(mcpRequest, signal())).rejects.toThrow(
      'test-cli runner does not support ephemeral MCP configuration',
    );
    expect(spawned).toBe(false);
  });

  it('allows an empty MCP server list and supporting runners', async () => {
    const plain = cliRunner('test-cli', process.execPath, stdoutScript('ok'));
    const capable = cliRunner('test-cli', process.execPath, stdoutScript('ok'), {
      supportsEphemeralMcp: true,
    });

    await expect(settle(plain, { ...request, mcpServers: [] })).resolves.toMatchObject({
      transport: 'succeeded',
    });
    await expect(settle(capable, mcpRequest)).resolves.toMatchObject({
      transport: 'succeeded',
    });
  });
});
