import {
  createClaudeRunner,
  createCodexRunner,
  createCommandRunner,
  createCursorRunner,
  FakeExecutionRunner,
  RunnerRegistry,
} from '../execution/index.js';
import type { ResolvedWakeModulesConfig } from './config/load-config.js';

type AgentRunnerConfig = NonNullable<
  ResolvedWakeModulesConfig['execution']['agentRunners']
>[string];

export function createRunnerRegistry(
  config: ResolvedWakeModulesConfig['execution'],
): RunnerRegistry {
  const runners = Object.fromEntries(
    Object.entries(config.agentRunners ?? {}).map(([name, runner]) => [
      name,
      createConfiguredRunner(runner),
    ]),
  );
  return new RunnerRegistry(config.tiers, runners);
}

// `kind` names the transport adapter, not the vendor, so each variant carries only the
// fields its transport actually needs.
function createConfiguredRunner(runner: AgentRunnerConfig) {
  switch (runner.kind) {
    case 'fake':
      return new FakeExecutionRunner();
    case 'claude-cli':
      return createClaudeRunner(runner.command, runner.timeoutMs, runner.args);
    case 'codex-cli':
      return createCodexRunner(runner.command, runner.timeoutMs, runner.args);
    case 'cursor-cli':
      return createCursorRunner(runner.command, runner.timeoutMs, runner.args);
    case 'command': {
      if (runner.command === undefined) throw new Error('Command runner requires a command');
      return createCommandRunner(runner.command, runner.args, runner.timeoutMs);
    }
  }
}
