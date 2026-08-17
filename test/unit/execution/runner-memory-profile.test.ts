import { expect, it, vi } from 'vitest';
import * as Execution from '../../../src/execution/index.js';
import { RunStatus, type Runner } from '../../../src/execution/index.js';

it('records bounded runner lifecycle memory without prompt or result content', async () => {
  const factory = (
    Execution as unknown as {
      readonly createRunnerMemoryProfileDecorator?: unknown;
    }
  ).createRunnerMemoryProfileDecorator;

  expect(factory).toBeTypeOf('function');
  if (typeof factory !== 'function') return;
  const write = vi.fn();
  const decorate = (
    factory as (options: {
      readonly write: (line: string) => void;
      readonly now: () => string;
      readonly memoryUsage: () => NodeJS.MemoryUsage;
    }) => (runner: Runner, name: string) => Runner
  )({
    write,
    now: () => '2026-08-17T05:00:00.000Z',
    memoryUsage: () => ({
      rss: 101,
      heapTotal: 102,
      heapUsed: 103,
      external: 104,
      arrayBuffers: 105,
    }),
  });
  const result = Promise.resolve({
    transport: RunStatus.Succeeded,
    output: 'secret runner output',
    runner: 'codex',
  });
  const runner: Runner = {
    start: async () => ({
      identity: { kind: 'process', id: 'external-1', startedAt: '2026-08-17T05:00:00.000Z' },
      result,
      cancel: vi.fn(),
    }),
  };

  const execution = await decorate(runner, 'codex').start(
    { runId: 'run-1', prompt: 'secret prompt', allowedTools: [] },
    new AbortController().signal,
  );
  await execution.result;

  expect(write.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    expect.objectContaining({ phase: 'runner.start.before', runner: 'codex', runId: 'run-1' }),
    expect.objectContaining({ phase: 'runner.start.returned', runner: 'codex', runId: 'run-1' }),
    expect.objectContaining({ phase: 'runner.result.settled', runner: 'codex', runId: 'run-1' }),
  ]);
  expect(write.mock.calls.flat().join('')).not.toContain('secret');
});
