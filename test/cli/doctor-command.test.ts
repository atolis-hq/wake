import { describe, expect, it, vi } from 'vitest';

import { runDoctorCommand, type DoctorDeps } from '../../src/cli/doctor-command.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import type { WakeConfig } from '../../src/domain/types.js';

function baseDockerDeps(): Pick<
  DoctorDeps,
  | 'hasDockerfile'
  | 'dockerReachable'
  | 'inspectImage'
  | 'wakeRoot'
  | 'image'
  | 'containerRunning'
  | 'execVersionInContainer'
  | 'installedVersion'
  | 'diffPromptsAndDockerfile'
> {
  return {
    hasDockerfile: async () => false,
    dockerReachable: async () => true,
    inspectImage: async () => true,
    wakeRoot: '/tmp/wake',
    image: 'wake-sandbox-x',
    containerRunning: async () => false,
    execVersionInContainer: async () => '',
    installedVersion: '0.1.22',
    diffPromptsAndDockerfile: async () => [],
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
      containerRunning: async () => false,
      execVersionInContainer: async () => '',
      installedVersion: '0.1.22',
      diffPromptsAndDockerfile: async () => [],
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
      containerRunning: async () => false,
      execVersionInContainer: async () => '',
      installedVersion: '0.1.22',
      diffPromptsAndDockerfile: async () => [],
    });

    expect(dockerReachable).not.toHaveBeenCalled();
  });
});

describe('runDoctorCommand — version and prompt/Dockerfile drift notices', () => {
  it('adds an informational notice (not a failure) on a version mismatch', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => 'tok',
      hasDockerfile: async () => false,
      dockerReachable: async () => true,
      inspectImage: async () => true,
      wakeRoot: '/tmp/wake',
      image: 'x',
      containerRunning: async () => true,
      execVersionInContainer: async () => '0.1.20',
      installedVersion: '0.1.22',
      diffPromptsAndDockerfile: async () => [],
    });

    expect(report.failures).toEqual([]);
    expect(report.notices.some((n) => n.includes('0.1.20') && n.includes('0.1.22'))).toBe(true);
  });

  it('adds an informational notice per drifted file, never a failure', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => 'tok',
      hasDockerfile: async () => false,
      dockerReachable: async () => true,
      inspectImage: async () => true,
      wakeRoot: '/tmp/wake',
      image: 'x',
      containerRunning: async () => false,
      execVersionInContainer: async () => '',
      installedVersion: '0.1.22',
      diffPromptsAndDockerfile: async () => ['prompts/refine.md', 'docker/Dockerfile'],
    });

    expect(report.failures).toEqual([]);
    expect(report.notices.some((n) => n.includes('prompts/refine.md'))).toBe(true);
    expect(report.notices.some((n) => n.includes('docker/Dockerfile'))).toBe(true);
  });

  it('still returns a report when containerRunning throws, and does not add a failure', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => 'tok',
      ...baseDockerDeps(),
      containerRunning: async () => {
        throw new Error('docker not found');
      },
    });

    expect(report.failures).toEqual([]);
  });

  it('still returns a report when execVersionInContainer throws, and does not add a failure', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => 'tok',
      ...baseDockerDeps(),
      containerRunning: async () => true,
      execVersionInContainer: async () => {
        throw new Error('exec failed');
      },
    });

    expect(report.failures).toEqual([]);
  });

  it('still returns a report when diffPromptsAndDockerfile throws, and does not add a failure', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken: async () => 'tok',
      ...baseDockerDeps(),
      diffPromptsAndDockerfile: async () => {
        throw new Error('fs error');
      },
    });

    expect(report.failures).toEqual([]);
  });
});
