import { execFile as nodeExecFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { WorkspaceManager } from '../core/contracts.js';
import { agentActionValues } from '../domain/stages.js';
import type { RunnerEntry, WakeConfig } from '../domain/types.js';
import { loadPromptTemplate } from '../adapters/runner/prompt-templates.js';

const execFile = promisify(nodeExecFile);
const runnerVersionProbeTimeoutMs = 5_000;

type RealRunnerEntry = Exclude<RunnerEntry, { kind: 'fake' }>;

export interface StartupPreflightDeps {
  loadPrompt?: (action: string, mode: 'start' | 'resume', promptsRoot?: string) => Promise<void>;
  checkRunnerCommand?: (runnerName: string, entry: RealRunnerEntry) => Promise<void>;
  workspaceManager?: Pick<WorkspaceManager, 'prepareReadOnlyClone'>;
  runnerOverride?: string;
}

function activeRunnerNames(config: WakeConfig, runnerOverride: string | undefined): Set<string> {
  const names = new Set<string>();
  if (runnerOverride !== undefined) {
    names.add(runnerOverride);
    return names;
  }

  for (const candidates of Object.values(config.tiers)) {
    for (const candidate of candidates) {
      names.add(candidate);
    }
  }

  for (const route of Object.values(config.stages)) {
    if (route.runner !== undefined) {
      names.add(route.runner);
    }
  }

  return names;
}

function formatPreflightFailures(failures: string[]): Error {
  return new Error(
    [
      'Wake startup preflight failed:',
      ...failures.map((failure) => `- ${failure}`),
      '',
      'Fix the configuration or environment, then run `wake start` again.',
    ].join('\n'),
  );
}

async function defaultLoadPrompt(
  action: string,
  mode: 'start' | 'resume',
  promptsRoot?: string,
): Promise<void> {
  await loadPromptTemplate(action, mode, {
    ...(promptsRoot === undefined ? {} : { promptsRoot }),
  });
}

async function defaultCheckRunnerCommand(
  runnerName: string,
  entry: RealRunnerEntry,
): Promise<void> {
  try {
    await execFile(entry.command, ['--version'], {
      env: process.env,
      timeout: runnerVersionProbeTimeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `runner "${runnerName}" (${entry.kind}) command "${entry.command}" is not invocable: ${message}`,
    );
  }
}

async function assertPromptsRootAccessible(promptsRoot: string | undefined): Promise<void> {
  if (promptsRoot === undefined) {
    return;
  }

  await access(promptsRoot);
}

export async function runStartupPreflight(
  config: WakeConfig,
  deps: StartupPreflightDeps = {},
): Promise<void> {
  const failures: string[] = [];
  const loadPrompt = deps.loadPrompt ?? defaultLoadPrompt;
  const checkRunnerCommand = deps.checkRunnerCommand ?? defaultCheckRunnerCommand;

  try {
    await assertPromptsRootAccessible(config.paths.promptsRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`promptsRoot "${config.paths.promptsRoot}" is not readable: ${message}`);
  }

  for (const action of agentActionValues) {
    for (const mode of ['start', 'resume'] as const) {
      try {
        await loadPrompt(action, mode, config.paths.promptsRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const root = config.paths.promptsRoot ?? '(bundled prompts)';
        failures.push(
          `prompt template ${action}.${mode}.md under ${root} is not readable: ${message}`,
        );
      }
    }
  }

  const activeRunners = activeRunnerNames(config, deps.runnerOverride);
  let usesRealRunner = false;
  for (const runnerName of activeRunners) {
    const entry = config.runners[runnerName];
    if (entry === undefined) {
      failures.push(`routing references unknown runner "${runnerName}"`);
      continue;
    }

    if (entry.kind === 'fake') {
      continue;
    }

    usesRealRunner = true;
    try {
      await checkRunnerCommand(runnerName, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
    }
  }

  if (usesRealRunner && config.sources.github.enabled && config.sources.github.repos.length > 0) {
    if (deps.workspaceManager === undefined) {
      failures.push('canonical clone health could not be checked: no workspace manager was provided');
    } else {
      for (const repo of config.sources.github.repos) {
        try {
          await deps.workspaceManager.prepareReadOnlyClone({ repo });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`canonical clone for ${repo} is not healthy or clone-able: ${message}`);
        }
      }
    }
  }

  if (failures.length > 0) {
    throw formatPreflightFailures(failures);
  }
}
