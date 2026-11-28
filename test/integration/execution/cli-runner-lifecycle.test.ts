import { describe, expect, it } from 'vitest';
import { cliRunner, type RunnerRequest } from '../../../src/execution/index.js';

const request: RunnerRequest = { runId: 'run-1', prompt: 'ignored', allowedTools: [] };
const hang = ['-e', 'setTimeout(() => {}, 5_000)'];
const fastTimeouts = { hardMs: 20, cancellationGraceMs: 5 };

interface Run {
  readonly id: number;
}

// Records every lifecycle step so each test can assert ordering and counts.
function lifecycle() {
  const events: string[] = [];
  let next = 0;
  return {
    events,
    prepare: (): Run => {
      const run = { id: ++next };
      events.push(`prepare:${run.id}`);
      return run;
    },
    cleanup: (run: Run) => {
      events.push(`cleanup:${run.id}`);
    },
  };
}

describe('cliRunner per-invocation lifecycle', () => {
  it('hands the prepared context to the argument builder and result hooks, then cleans up', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      (_request, run) => {
        life.events.push(`args:${run.id}`);
        return ['-e', 'process.stdout.write("raw")'];
      },
      {
        ...life,
        rejectSuccessfulExit: (_stdout, _request, run) => {
          life.events.push(`reject:${run.id}`);
          return undefined;
        },
        parseSuccessfulOutput: (_stdout, _request, run) => {
          life.events.push(`parse:${run.id}`);
          return { output: 'parsed' };
        },
      },
    );

    const execution = await runner.start(request, new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({ output: 'parsed' });
    expect(life.events).toEqual(['prepare:1', 'args:1', 'reject:1', 'parse:1', 'cleanup:1']);
  });

  it('prepares and cleans up separately for every start', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      (_request, run) => ['-e', `process.stdout.write("run ${run.id}")`],
      { ...life },
    );

    const first = await runner.start(request, new AbortController().signal);
    const second = await runner.start(request, new AbortController().signal);

    await expect(first.result).resolves.toMatchObject({ output: 'run 1' });
    await expect(second.result).resolves.toMatchObject({ output: 'run 2' });
    expect(life.events.filter((event) => event.startsWith('cleanup')).sort()).toEqual([
      'cleanup:1',
      'cleanup:2',
    ]);
  });

  it('cleans up once after a non-zero exit', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>('test-cli', process.execPath, () => ['-e', 'process.exit(3)'], {
      ...life,
    });

    const execution = await runner.start(request, new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({ transport: 'failed' });
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('cleans up once after a timeout', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>('test-cli', process.execPath, () => hang, {
      ...life,
      runnerTimeouts: fastTimeouts,
    });

    const execution = await runner.start(request, new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({ transport: 'failed' });
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('cleans up once after the signal aborts', async () => {
    const life = lifecycle();
    const controller = new AbortController();
    const runner = cliRunner<Run>('test-cli', process.execPath, () => hang, {
      ...life,
      runnerTimeouts: { cancellationGraceMs: 5 },
    });

    const execution = await runner.start(request, controller.signal);
    controller.abort();
    await expect(execution.result).resolves.toMatchObject({ transport: 'failed' });
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('cleans up once after the execution is cancelled', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>('test-cli', process.execPath, () => hang, {
      ...life,
      runnerTimeouts: { cancellationGraceMs: 5 },
    });

    const execution = await runner.start(request, new AbortController().signal);
    await execution.cancel('test');
    await expect(execution.result).resolves.toMatchObject({ transport: 'failed' });
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('cleans up once when the output parser throws', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      () => ['-e', 'process.stdout.write("raw")'],
      {
        ...life,
        parseSuccessfulOutput: () => {
          throw new Error('parser blew up');
        },
      },
    );

    const execution = await runner.start(request, new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({
      transport: 'succeeded',
      output: 'raw',
    });
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('cleans up once when the rejection check throws, and still surfaces its error', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      () => ['-e', 'process.stdout.write("raw")'],
      {
        ...life,
        rejectSuccessfulExit: () => {
          throw new Error('check blew up');
        },
      },
    );

    const execution = await runner.start(request, new AbortController().signal);
    await expect(execution.result).rejects.toThrow('check blew up');
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('waits for an asynchronous cleanup before resolving the result', async () => {
    let cleaned = false;
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      () => ['-e', 'process.stdout.write("raw")'],
      {
        prepare: () => ({ id: 1 }),
        cleanup: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          cleaned = true;
        },
      },
    );

    const execution = await runner.start(request, new AbortController().signal);
    await execution.result;
    expect(cleaned).toBe(true);
  });

  it('keeps the run result when cleanup itself fails', async () => {
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      () => ['-e', 'process.stdout.write("raw")'],
      {
        prepare: () => ({ id: 1 }),
        cleanup: () => {
          throw new Error('cleanup blew up');
        },
      },
    );

    const execution = await runner.start(request, new AbortController().signal);
    await expect(execution.result).resolves.toMatchObject({ transport: 'succeeded' });
  });
});

describe('cliRunner lifecycle when starting fails', () => {
  it('cleans up and rethrows when the argument builder throws', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      () => {
        throw new Error('args blew up');
      },
      { ...life },
    );

    await expect(runner.start(request, new AbortController().signal)).rejects.toThrow(
      'args blew up',
    );
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('cleans up and rethrows when the process cannot be spawned', async () => {
    const life = lifecycle();
    // A NUL byte makes child_process.spawn throw synchronously.
    const runner = cliRunner<Run>('test-cli', process.execPath, () => ['bad\0arg'], { ...life });

    await expect(runner.start(request, new AbortController().signal)).rejects.toThrow();
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('cleans up and rethrows when the stdout decoder factory throws', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>('test-cli', process.execPath, () => [], {
      ...life,
      createStdoutDecoder: () => {
        throw new Error('decoder blew up');
      },
    });

    await expect(runner.start(request, new AbortController().signal)).rejects.toThrow(
      'decoder blew up',
    );
    expect(life.events).toEqual(['prepare:1', 'cleanup:1']);
  });

  it('rethrows the start error even when cleanup also fails', async () => {
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      () => {
        throw new Error('args blew up');
      },
      {
        prepare: () => ({ id: 1 }),
        cleanup: () => {
          throw new Error('cleanup blew up');
        },
      },
    );

    await expect(runner.start(request, new AbortController().signal)).rejects.toThrow(
      'args blew up',
    );
  });

  it('does not clean up when prepare itself fails', async () => {
    const events: string[] = [];
    const runner = cliRunner<Run>(
      'test-cli',
      process.execPath,
      () => {
        events.push('args');
        return [];
      },
      {
        prepare: () => {
          throw new Error('prepare blew up');
        },
        cleanup: () => {
          events.push('cleanup');
        },
      },
    );

    await expect(runner.start(request, new AbortController().signal)).rejects.toThrow(
      'prepare blew up',
    );
    expect(events).toEqual([]);
  });

  it('refuses unsupported MCP servers before preparing anything', async () => {
    const life = lifecycle();
    const runner = cliRunner<Run>('test-cli', process.execPath, () => [], { ...life });

    await expect(
      runner.start(
        { ...request, mcpServers: [{ name: 'wake', command: 'wake' }] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('does not support ephemeral MCP');
    expect(life.events).toEqual([]);
  });
});
