import { createClaudeRunner } from '../claude/claude-runner.js';
import { createCodexRunner } from '../codex/codex-runner.js';
import { createCursorRunner } from '../cursor/cursor-runner.js';
import { createFakeRunner } from '../fake/fake-runner.js';
import type { AgentRunner } from '../../core/contracts.js';
import { resolveRunnerRouting } from '../../domain/runner-routing.js';
import {
  chooseAction,
  workflowForProjection,
  workflowNameForProjection,
} from '../../domain/workflows.js';
import type { RunnerEntry, RunnerKind, RunnerRouting, WakeConfig } from '../../domain/types.js';

export { resolveRunnerRouting } from '../../domain/runner-routing.js';

export interface ResolvedRunner {
  runner: AgentRunner;
  routing: RunnerRouting;
}

function withoutKind<T extends RunnerEntry>(entry: T): Omit<T, 'kind'> {
  const { kind: _kind, ...settings } = entry;
  return settings;
}

function createRunnerForEntry(input: {
  name: string;
  entry: RunnerEntry;
  config: WakeConfig;
  cwd: string;
}): AgentRunner {
  if (input.entry.kind === 'fake') {
    return createFakeRunner(undefined, { cli: input.entry.cli });
  }

  if (input.entry.kind === 'claude') {
    const settings = withoutKind(input.entry);
    return createClaudeRunner({
      command: settings.command,
      cwd: input.cwd,
      settings,
    });
  }

  if (input.entry.kind === 'cursor') {
    const settings = withoutKind(input.entry);
    return createCursorRunner({
      command: settings.command,
      cwd: input.cwd,
      settings,
    });
  }

  const settings = withoutKind(input.entry);
  return createCodexRunner({
    command: settings.command,
    cwd: input.cwd,
    settings,
  });
}

async function runWithRouting(input: {
  runner: AgentRunner;
  routing: RunnerRouting;
  runInput: Parameters<AgentRunner['run']>[0];
}) {
  const result = await input.runner.run({
    ...input.runInput,
    routing: input.routing,
  });
  return {
    ...result,
    routing: input.routing,
    metadata: {
      ...result.metadata,
      routing: input.routing,
    },
  };
}

export function createRegistryRunner(input: {
  config: WakeConfig;
  cwd: string;
  override?: string;
}): AgentRunner {
  if (input.override === 'fake') {
    const runner = createFakeRunner();
    return {
      run(runInput) {
        return runWithRouting({
          runner,
          runInput,
          routing: {
            runnerName: 'fake',
            runnerKind: 'fake',
            reason: '--runner fake override',
          },
        });
      },
    };
  }

  if (input.override !== undefined) {
    const entry = input.config.runners[input.override];
    if (entry === undefined) {
      throw new Error(`Unsupported runner override: ${input.override}`);
    }
    const runner = createRunnerForEntry({
      name: input.override,
      entry,
      config: input.config,
      cwd: input.cwd,
    });
    return {
      run(runInput) {
        return runWithRouting({
          runner,
          runInput,
          routing: {
            runnerName: input.override as string,
            runnerKind: entry.kind,
            reason: `--runner ${input.override} override`,
          },
        });
      },
    };
  }

  const cache = new Map<string, AgentRunner>();

  return {
    async run(runInput) {
      // Callers that already resolved routing against the ledger (tick-runner,
      // so it can skip claiming a run when every candidate is paused) pass it
      // in; only fall back to a ledger-less resolve for direct callers (smoke
      // tests, sandbox exec) that never see quota state.
      const routing =
        runInput.routing ??
        (() => {
          const workflow = workflowForProjection(runInput.projection, runInput.config);
          const workflowAction =
            workflow === null ? null : chooseAction(runInput.projection, workflow);
          return resolveRunnerRouting({
            config: runInput.config,
            stage: workflowAction?.stage ?? runInput.projection.wake.stage,
            action: runInput.action,
            workflowName: workflowNameForProjection(runInput.projection, runInput.config),
          });
        })();
      if (routing === null) {
        throw new Error(
          'No runner available: every candidate in the resolved tier is quota-paused.',
        );
      }
      const cacheKey = `${routing.runnerKind}:${routing.runnerName}`;
      const existing = cache.get(cacheKey);
      const runner =
        existing ??
        createRunnerForEntry({
          name: routing.runnerName,
          entry: runInput.config.runners[routing.runnerName]!,
          config: runInput.config,
          cwd: input.cwd,
        });
      cache.set(cacheKey, runner);
      return runWithRouting({
        runner,
        routing,
        runInput,
      });
    },
  };
}

export function runnerKindForOverride(config: WakeConfig, override: string): RunnerKind | null {
  if (override === 'fake') {
    return 'fake';
  }
  return config.runners[override]?.kind ?? null;
}
