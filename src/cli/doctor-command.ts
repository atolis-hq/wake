import type { WakeConfig } from '../domain/types.js';

export type DoctorDeps = {
  collectPreflightFailures: (config: WakeConfig) => Promise<string[]>;
  resolveGitHubToken: () => Promise<string>;
  hasDockerfile: (wakeRoot: string) => Promise<boolean>;
  dockerReachable: () => Promise<boolean>;
  inspectImage: (image: string) => Promise<boolean>;
  wakeRoot: string;
  image: string;
  containerRunning: () => Promise<boolean>;
  execVersionInContainer: () => Promise<string>;
  installedVersion: string;
  diffPromptsAndDockerfile: () => Promise<string[]>;
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

  if (await deps.containerRunning()) {
    const sandboxVersion = await deps.execVersionInContainer();
    if (sandboxVersion !== '' && sandboxVersion !== deps.installedVersion) {
      notices.push(
        `sandbox is running version ${sandboxVersion}, installed CLI is ${deps.installedVersion} — run \`wake sandbox build && wake sandbox update\` to sync`,
      );
    }
  }

  const driftedFiles = await deps.diffPromptsAndDockerfile();
  for (const file of driftedFiles) {
    notices.push(`${file} differs from the currently-shipped default (not auto-overwritten)`);
  }

  return { failures, notices };
}
