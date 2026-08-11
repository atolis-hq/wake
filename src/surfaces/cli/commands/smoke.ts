import { RunStatus, type RunnerRegistry } from '../../../execution/index.js';

export interface SmokeRunner {
  run(): Promise<{ readonly ok: boolean }>;
}

export const runSmoke = (runner: SmokeRunner) => runner.run();

export async function runTargetSmoke(
  registry: Pick<RunnerRegistry, 'resolve'>,
  runnerPool: string,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly runner: string; readonly transport: string }> {
  const selected = registry.resolve(runnerPool);
  const execution = await selected.runner.start(
    {
      runId: `smoke-${Date.now()}`,
      prompt: 'Wake target smoke check. Return DONE.',
      allowedTools: [],
    },
    signal,
  );
  const result = await execution.result;
  return {
    ok: result.transport === RunStatus.Succeeded,
    runner: result.runner,
    transport: result.transport,
  };
}
