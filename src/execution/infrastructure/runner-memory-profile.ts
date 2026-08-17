import type { Runner } from '../contracts/runner.js';

export interface RunnerMemoryProfileOptions {
  readonly write: (line: string) => void;
  readonly now: () => string;
  readonly memoryUsage: () => NodeJS.MemoryUsage;
}

export function createRunnerMemoryProfileDecorator(options: RunnerMemoryProfileOptions) {
  return (runner: Runner, name: string): Runner => ({
    ...(runner.supportsSessionResume === undefined
      ? {}
      : { supportsSessionResume: runner.supportsSessionResume }),
    start: async (request, signal) => {
      writeSample(options, 'runner.start.before', name, request.runId);
      const execution = await runner.start(request, signal);
      writeSample(options, 'runner.start.returned', name, request.runId);
      return {
        ...execution,
        result: execution.result.finally(() => {
          writeSample(options, 'runner.result.settled', name, request.runId);
        }),
      };
    },
  });
}

function writeSample(
  options: RunnerMemoryProfileOptions,
  phase: 'runner.start.before' | 'runner.start.returned' | 'runner.result.settled',
  runner: string,
  runId: string,
): void {
  const memory = options.memoryUsage();
  options.write(
    `${JSON.stringify({
      type: 'wake.runner-memory',
      phase,
      at: options.now(),
      pid: process.pid,
      runner,
      runId,
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    })}\n`,
  );
}
