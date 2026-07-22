import { describe, expect, it, vi } from 'vitest';

import { runDoctorCommand } from '../../src/cli/doctor-command.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import type { WakeConfig } from '../../src/domain/types.js';

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
    });

    expect(report.failures.some((f) => f.includes('GitHub token'))).toBe(true);
  });

  it('does not check the token when github source is disabled', async () => {
    const resolveGitHubToken = vi.fn(async () => 'tok');

    await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => [],
      resolveGitHubToken,
    });

    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });

  it('includes existing preflight failures verbatim', async () => {
    const report = await runDoctorCommand(baseConfig(), {
      collectPreflightFailures: async () => ['prompt template x.md is not readable'],
      resolveGitHubToken: async () => 'tok',
    });

    expect(report.failures).toContain('prompt template x.md is not readable');
  });
});
