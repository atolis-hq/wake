import { createClaudeRunner } from '../claude/claude-runner.js';
import { createCodexRunner } from '../codex/codex-runner.js';
import { createFakeRunner } from '../fake/fake-runner.js';
import type { AgentRunner } from '../../core/contracts.js';
import type {
  AgentAction,
  RunnerEntry,
  RunnerKind,
  RunnerRouting,
  Stage,
  WakeConfig,
} from '../../domain/types.js';

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
    const runner = createClaudeRunner({
      command: settings.command,
      cwd: input.cwd,
    });
    return {
      run(runInput) {
        return runner.run({
          ...runInput,
          config: {
            ...runInput.config,
            runner: {
              ...runInput.config.runner,
              mode: 'claude',
              claude: settings,
            },
          },
        });
      },
    };
  }

  const settings = withoutKind(input.entry);
  const runner = createCodexRunner({
    command: settings.command,
    cwd: input.cwd,
  });
  return {
    run(runInput) {
      return runner.run({
        ...runInput,
        config: {
          ...runInput.config,
          runner: {
            ...runInput.config.runner,
            mode: 'codex',
            codex: settings,
          },
        },
      });
    },
  };
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

export function resolveRunnerRouting(input: {
  config: WakeConfig;
  stage: Stage;
  action: AgentAction;
}): RunnerRouting {
  const stageRoute = input.config.stages[input.stage];

  if (stageRoute?.runner !== undefined) {
    const entry = input.config.runners[stageRoute.runner];
    if (entry === undefined) {
      throw new Error(`Stage ${input.stage} pins unknown runner "${stageRoute.runner}".`);
    }
    return {
      runnerName: stageRoute.runner,
      runnerKind: entry.kind,
      ...(stageRoute.tier === undefined ? {} : { tier: stageRoute.tier }),
      reason: `stage ${input.stage} pins runner ${stageRoute.runner}`,
    };
  }

  const tier = stageRoute?.tier ?? input.config.defaultTier;
  const candidates = input.config.tiers[tier];
  if (candidates === undefined || candidates.length === 0) {
    throw new Error(`Stage ${input.stage} routes to unknown or empty tier "${tier}".`);
  }

  const runnerName = candidates[0]!;
  const entry = input.config.runners[runnerName];
  if (entry === undefined) {
    throw new Error(`Tier ${tier} references unknown runner "${runnerName}".`);
  }

  return {
    runnerName,
    runnerKind: entry.kind,
    tier,
    reason:
      stageRoute?.tier === undefined
        ? `defaultTier ${tier} selected runner ${runnerName}`
        : `stage ${input.stage} tier ${tier} selected runner ${runnerName}`,
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
      const routing = resolveRunnerRouting({
        config: runInput.config,
        stage: runInput.projection.wake.stage,
        action: runInput.action,
      });
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

export function runnerKindForOverride(
  config: WakeConfig,
  override: string,
): RunnerKind | null {
  if (override === 'fake') {
    return 'fake';
  }
  return config.runners[override]?.kind ?? null;
}
