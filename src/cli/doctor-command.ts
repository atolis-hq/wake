import type { WakeConfig } from '../domain/types.js';

export type DoctorDeps = {
  collectPreflightFailures: (config: WakeConfig) => Promise<string[]>;
  resolveGitHubToken: () => Promise<string>;
  hasDockerfile: (wakeRoot: string) => Promise<boolean>;
  dockerReachable: () => Promise<boolean>;
  inspectImage: (image: string) => Promise<boolean>;
  wakeRoot: string;
  image: string;
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

  if (await deps.hasDockerfile(deps.wakeRoot)) {
    const reachable = await deps.dockerReachable();
    if (!reachable) {
      failures.push('Docker daemon is not reachable');
    } else {
      const imageExists = await deps.inspectImage(deps.image);
      if (!imageExists) {
        failures.push(`sandbox image "${deps.image}" not found — run \`wake sandbox build\``);
      }
    }
  }

  return { failures, notices };
}
