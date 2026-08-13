import {
  createClaudeRunner,
  createCodexRunner,
  createCommandRunner,
  createCursorRunner,
  emptyFakeScenarios,
  FakeExecutionRunner,
  RunnerRegistry,
  type FakeScenarioResolver,
  type Runner,
} from '../execution/index.js';
import type { ResolvedWakeModulesConfig } from './config/load-config.js';

type AgentRunnerConfig = NonNullable<
  ResolvedWakeModulesConfig['execution']['agentRunners']
>[string];

export function createRunnerRegistry(
  config: ResolvedWakeModulesConfig['execution'],
  scenarios: FakeScenarioResolver = emptyFakeScenarios,
  decorateRunner?: (runner: Runner, name: string) => Runner,
): RunnerRegistry {
  const runners = Object.fromEntries(
    Object.entries(config.agentRunners ?? {}).map(([name, runner]) => [
      name,
      (decorateRunner ?? identity)(createConfiguredRunner(name, runner, scenarios), name),
    ]),
  );
  return new RunnerRegistry(config.runnerPools, runners);
}

function identity<T>(value: T): T {
  return value;
}

// `kind` names the transport adapter, not the vendor, so each variant carries only the
// fields its transport actually needs.
function createConfiguredRunner(
  name: string,
  runner: AgentRunnerConfig,
  scenarios: FakeScenarioResolver,
) {
  switch (runner.kind) {
    case 'fake':
      return new FakeExecutionRunner(name, scenarios);
    case 'claude-cli':
      return createClaudeRunner(runner);
    case 'codex-cli':
      return createCodexRunner(runner);
    case 'cursor-cli':
      return createCursorRunner(runner);
    case 'command': {
      if (runner.command === undefined) throw new Error('Command runner requires a command');
      return createCommandRunner(runner.command, runner.args, runner.timeoutMs);
    }
  }
}
