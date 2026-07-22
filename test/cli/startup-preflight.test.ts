import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  collectStartupPreflightFailures,
  runStartupPreflight,
} from '../../src/cli/startup-preflight.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import type { WakeConfig } from '../../src/domain/types.js';

function baseConfig(): WakeConfig {
  const config = createDefaultWakeConfig();
  return {
    ...config,
    paths: {
      wakeRoot: config.paths.wakeRoot,
    },
  };
}

async function writePromptSet(root: string): Promise<void> {
  for (const action of ['refine', 'implement']) {
    await writeFile(
      join(root, `${action}.md`),
      `---\nstage: ${action}\nmaxTurns: 1\n---\n${action} {{mode}}`,
      'utf8',
    );
  }
}

describe('startup preflight', () => {
  it('validates all bundled stage prompt templates are readable', async () => {
    await expect(runStartupPreflight(baseConfig())).resolves.toBeUndefined();
  });

  it('fails fast when a configured prompts root cannot satisfy required templates', async () => {
    const promptsRoot = await mkdtemp(join(tmpdir(), 'wake-preflight-prompts-'));
    await writeFile(
      join(promptsRoot, 'refine.start.md'),
      '---\nstage: refine\nmode: start\nmaxTurns: 1\n---\nrefine',
      'utf8',
    );
    const config: WakeConfig = {
      ...baseConfig(),
      paths: {
        ...baseConfig().paths,
        promptsRoot,
      },
    };

    await expect(runStartupPreflight(config)).rejects.toThrow(
      /Wake startup preflight failed:[\s\S]*prompt template refine\.md or refine\.resume\.md/,
    );
  });

  it('collectStartupPreflightFailures returns the same failures runStartupPreflight would throw, without throwing', async () => {
    const promptsRoot = await mkdtemp(join(tmpdir(), 'wake-preflight-prompts-'));
    await writeFile(
      join(promptsRoot, 'refine.start.md'),
      '---\nstage: refine\nmode: start\nmaxTurns: 1\n---\nrefine',
      'utf8',
    );
    const config: WakeConfig = {
      ...baseConfig(),
      paths: {
        ...baseConfig().paths,
        promptsRoot,
      },
    };

    const failures = await collectStartupPreflightFailures(config);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toContain('prompt template refine.md or refine.resume.md');
  });

  it('collectStartupPreflightFailures returns an empty array for a fully valid config', async () => {
    const failures = await collectStartupPreflightFailures(baseConfig());
    expect(failures).toEqual([]);
  });

  it('checks only real runners that are reachable through configured routing', async () => {
    const checkRunnerCommand = vi.fn(async () => {});

    await runStartupPreflight(baseConfig(), { checkRunnerCommand });

    expect(checkRunnerCommand).not.toHaveBeenCalled();
  });

  it('honors a fake runner override when real runners are configured', async () => {
    const checkRunnerCommand = vi.fn(async () => {});
    const config: WakeConfig = {
      ...baseConfig(),
      runners: {
        fake: { kind: 'fake', cli: 'Fake' },
        codex: {
          kind: 'codex',
          command: 'codex',
          model: 'gpt-5.5',
          smokeModel: 'gpt-5.4-mini',
          smokePrompt: 'hi',
          timeoutMs: 1000,
          models: { default: 'gpt-5.5' },
        },
      },
      tiers: { standard: ['codex'] },
      defaultTier: 'standard',
      stages: { implement: { action: 'implement', tier: 'standard' } },
    };

    await runStartupPreflight(config, { runnerOverride: 'fake', checkRunnerCommand });

    expect(checkRunnerCommand).not.toHaveBeenCalled();
  });

  it('fails fast when an active real runner command is not invocable', async () => {
    const config: WakeConfig = {
      ...baseConfig(),
      runners: {
        cursor: {
          kind: 'cursor',
          command: 'missing-cursor',
          model: 'composer-2.5',
          smokeModel: 'auto',
          smokePrompt: 'hi',
          timeoutMs: 1000,
          models: { default: 'composer-2.5' },
        },
      },
      tiers: { standard: ['cursor'] },
      defaultTier: 'standard',
      stages: { implement: { action: 'implement', tier: 'standard' } },
    };

    await expect(
      runStartupPreflight(config, {
        checkRunnerCommand: async () => {
          throw new Error('runner "cursor" (cursor) command "missing-cursor" is not invocable');
        },
      }),
    ).rejects.toThrow(/runner "cursor" \(cursor\) command "missing-cursor" is not invocable/);
  });

  it('validates canonical clones for watched repos when real runners are active', async () => {
    const promptsRoot = await mkdtemp(join(tmpdir(), 'wake-preflight-prompts-'));
    await writePromptSet(promptsRoot);
    const config: WakeConfig = {
      ...baseConfig(),
      paths: {
        ...baseConfig().paths,
        promptsRoot,
      },
      runners: {
        codex: {
          kind: 'codex',
          command: 'codex',
          model: 'gpt-5.5',
          smokeModel: 'gpt-5.4-mini',
          smokePrompt: 'hi',
          timeoutMs: 1000,
          models: { default: 'gpt-5.5' },
        },
      },
      tiers: { standard: ['codex'] },
      defaultTier: 'standard',
      stages: { implement: { action: 'implement', tier: 'standard' } },
      sources: {
        github: {
          enabled: true,
          repos: ['atolis-hq/wake'],
          polling: { maxIssuesPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 },
          policy: { requiredLabels: [], ignoredLabels: [], requiredAssignees: [] },
          publication: { postStatusComments: true },
          pullRequests: {
            enabled: false,
            maxPullRequestsPerRepo: 25,
            commentPageSize: 25,
            checks: { enabled: true },
            policy: { requiredAuthors: [] },
          },
        },
      },
    };

    await expect(
      runStartupPreflight(config, {
        checkRunnerCommand: async () => {},
        workspaceManager: {
          async prepareReadOnlyClone() {
            throw new Error('git clone --no-local failed');
          },
        },
      }),
    ).rejects.toThrow(/canonical clone for atolis-hq\/wake is not healthy or clone-able/);
  });
});
