import type { WakeConfig } from './types.js';

export function maxConfiguredRunnerTimeoutMs(config: WakeConfig): number {
  const activeRunnerNames = new Set(
    Object.values(config.tiers).flatMap((candidates) => candidates),
  );
  for (const stageRoute of Object.values(config.stages)) {
    if (stageRoute.runner !== undefined) {
      activeRunnerNames.add(stageRoute.runner);
    }
  }

  const registryTimeouts = [...activeRunnerNames]
    .map((name) => config.runners[name])
    .map((entry) =>
      entry === undefined || entry.kind === 'fake' ? undefined : entry.timeoutMs,
    )
    .filter((timeout): timeout is number => timeout !== undefined);

  return Math.max(
    config.runner.claude.timeoutMs,
    config.runner.codex.timeoutMs,
    ...registryTimeouts,
  );
}
