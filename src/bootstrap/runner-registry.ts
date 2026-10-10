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
    Object.entries(config.agentRunners ?? {}).map(([name, runner]) => {
      const configured = createConfiguredRunner(name, runner, scenarios);
      const decorated = (decorateRunner ?? identity)(configured, name);
      return [name, preserveRunnerCapabilities(configured, decorated)];
    }),
  );
  return new RunnerRegistry(config.runnerPools, runners);
}

// Test and operational decorators commonly wrap only `start`; adapter capabilities
// describe the underlying transport and must survive that wrapper.
function preserveRunnerCapabilities(configured: Runner, decorated: Runner): Runner {
  const capabilities = {
    ...(decorated.supportsSessionResume === undefined &&
    configured.supportsSessionResume !== undefined
      ? { supportsSessionResume: configured.supportsSessionResume }
      : {}),
    ...(decorated.supportsEphemeralMcp === undefined &&
    configured.supportsEphemeralMcp !== undefined
      ? { supportsEphemeralMcp: configured.supportsEphemeralMcp }
      : {}),
  };
  if (Object.keys(capabilities).length === 0) return decorated;
  return Object.assign(Object.create(decorated), capabilities) as Runner;
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
      return createCommandRunner(runner.command, runner.args, runner.runnerTimeouts);
    }
  }
}
