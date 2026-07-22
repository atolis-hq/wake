import type { WakeConfig } from '../domain/types.js';

export type DoctorDeps = {
  collectPreflightFailures: (config: WakeConfig) => Promise<string[]>;
  resolveGitHubToken: () => Promise<string>;
};

export type DoctorReport = {
  failures: string[];
  notices: string[];
};

export async function runDoctorCommand(
  config: WakeConfig,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  const failures = [...(await deps.collectPreflightFailures(config))];
  const notices: string[] = [];

  if (config.sources.github.enabled) {
    try {
      await deps.resolveGitHubToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`GitHub token could not be resolved: ${message}`);
    }
  }

  return { failures, notices };
}
