import { describe, expect, it, vi } from 'vitest';

import { runDoctorCommand, type DoctorDeps } from '../../src/cli/doctor-command.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import type { WakeConfig } from '../../src/domain/types.js';

function baseDockerDeps(): Pick<
  DoctorDeps,
  'hasDockerfile' | 'dockerReachable' | 'inspectImage' | 'wakeRoot' | 'image'
> {
  return {
    hasDockerfile: async () => false,
    dockerReachable: async () => true,
    inspectImage: async () => true,
    wakeRoot: '/tmp/wake',
    image: 'wake-sandbox-x',
  };
}

function baseConfig(): WakeConfig {
  const config = createDefaultWakeConfig();
  return {
    ...config,
    sources: {
      ...config.sources,
      github: { ...config.sources.github, enabled: false, repos: [] },
    },
  };
}

describe('runDoctorCommand — GitHub token check', () => {
  it('adds a failure when github source is enabled and the token cannot be resolved', async () => {
    const config: WakeConfig = {
      ...baseConfig(),
      sources: {
        ...baseConfig().sources,
        github: { ...baseConfig().sources.github, enabled: true, repos: [] },
      },
    };

    const report = await runDoctorCommand(config, {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => {
        throw new Error('gh auth token failed');
      },
      ...baseDockerDeps(),
    });

    expect(report.failures.some((f) => f.includes('GitHub token'))).toBe(true);
  });

  it('does not check the token when github source is disabled', async () => {
    const resolveGitHubToken = vi.fn(async () => 'tok');

    await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken,
      ...baseDockerDeps(),
    });

    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });

  it('includes existing preflight failures verbatim', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => ['prompt template x.md is not readable'],
      resolveGitHubToken: async () => 'tok',
      ...baseDockerDeps(),
    });

    expect(report.failures).toContain('prompt template x.md is not readable');
  });
});

describe('runDoctorCommand — Docker/sandbox reachability check', () => {
  it('adds a failure when docker/Dockerfile exists but the Docker daemon is unreachable', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => 'tok',
      hasDockerfile: async () => true,
      dockerReachable: async () => false,
      inspectImage: async () => false,
      wakeRoot: '/tmp/wake',
      image: 'wake-sandbox-x',
    });

    expect(report.failures.some((f) => f.includes('Docker'))).toBe(true);
  });

  it('does not check Docker reachability when there is no docker/Dockerfile', async () => {
    const dockerReachable = vi.fn(async () => true);

    await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => 'tok',
      hasDockerfile: async () => false,
      dockerReachable,
      inspectImage: async () => true,
      wakeRoot: '/tmp/wake',
      image: 'wake-sandbox-x',
    });

    expect(dockerReachable).not.toHaveBeenCalled();
  });
});
