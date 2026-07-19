import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/adapters/github/github-auth.js', () => ({
  resolveGitHubToken: vi.fn(async () => 'fake-token'),
}));

// buildRuntime resolves its own authenticated login (for agent-authored
// bot-detection) as soon as a GitHub client exists, before any of the
// mocked-below adapters are constructed — a real Octokit client would hit
// the network with the fake token above.
vi.mock('../../src/adapters/github/github-client.js', () => ({
  createGitHubClient: vi.fn(() => ({
    getAuthenticatedLogin: vi.fn(async () => 'atolis-hq-agent'),
  })),
}));

const createGitHubArtifactVerifier = vi.fn(() => ({
  async verify() {
    return null;
  },
}));
vi.mock('../../src/adapters/github/github-artifact-verifier.js', () => ({
  createGitHubArtifactVerifier,
}));

const createGitHubPullRequestActivitySource = vi.fn(() => ({
  async pollEvents() {
    return [];
  },
  async deliverIntent() {
    return [];
  },
}));
vi.mock('../../src/adapters/github/github-pull-request-activity-source.js', () => ({
  createGitHubPullRequestActivitySource,
}));

// buildRuntime is imported after the mocks above so they take effect.
const { buildRuntime } = await import('../../src/main.js');

async function writeConfig(wakeRoot: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(wakeRoot, { recursive: true });
  await writeFile(join(wakeRoot, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

describe('buildRuntime PR tracking gating', () => {
  beforeEach(() => {
    createGitHubArtifactVerifier.mockClear();
    createGitHubPullRequestActivitySource.mockClear();
  });

  it('does not construct the PR activity source or artifact verifier when pullRequests.enabled is false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-build-runtime-'));
    const wakeRoot = join(root, '.wake');
    await writeConfig(wakeRoot, {
      sources: {
        github: {
          enabled: true,
          repos: ['org/repo'],
          pullRequests: { enabled: false },
        },
      },
    });

    await buildRuntime(['tick', '--wake-root', wakeRoot]);

    expect(createGitHubPullRequestActivitySource).not.toHaveBeenCalled();
    expect(createGitHubArtifactVerifier).not.toHaveBeenCalled();
  });

  it('constructs the PR activity source and artifact verifier when pullRequests.enabled is true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-build-runtime-'));
    const wakeRoot = join(root, '.wake');
    await writeConfig(wakeRoot, {
      sources: {
        github: {
          enabled: true,
          repos: ['org/repo'],
          pullRequests: { enabled: true },
        },
      },
    });

    await buildRuntime(['tick', '--wake-root', wakeRoot]);

    expect(createGitHubPullRequestActivitySource).toHaveBeenCalledTimes(1);
    expect(createGitHubArtifactVerifier).toHaveBeenCalledTimes(1);
  });
});
