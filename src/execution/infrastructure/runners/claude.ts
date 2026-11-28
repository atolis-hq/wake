import type { Runner, RunnerRequest } from '../../contracts/runner.js';
import { WakeMcpServerName } from '../../contracts/runner.js';
import {
  classifyClaudeFailure,
  ClaudeNoFinalResultFailureKind,
  parseClaudeOutput,
} from './claude-output.js';
import { createClaudeStreamDecoder } from './claude-stream.js';
import { cliRunner, type CliRunnerOptions, type RunnerDefaults } from './cli-runner.js';
import { mcpServersConfig } from './mcp-config.js';

export { classifyClaudeFailure, ClaudeNoFinalResultFailureKind, parseClaudeOutput };

export function createClaudeRunner(options: CliRunnerOptions = {}): Runner {
  return cliRunner(
    'claude',
    options.command ?? 'claude',
    (request) => claudeCommandArgs(request, options.args, options),
    {
      ...(options.runnerTimeouts === undefined ? {} : { runnerTimeouts: options.runnerTimeouts }),
      ...(options.model === undefined ? {} : { defaultModel: options.model }),
      parseSuccessfulOutput: parseClaudeOutput,
      unparsedSuccessFailure: {
        kind: ClaudeNoFinalResultFailureKind,
        message: 'Claude exited successfully without a usable final result event',
      },
      createStdoutDecoder: createClaudeStreamDecoder,
      classifyFailure: classifyClaudeFailure,
      supportsSessionResume: true,
      supportsEphemeralMcp: true,
    },
  );
}

// `claude -p` stays alive until a pending wakeup fires, even past its background-wait cap.
// A finished run would hang until Wake's idle timeout kills it and discards the result.
const claudeDisallowedTools = ['ScheduleWakeup'];

export function claudeCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
  defaults: RunnerDefaults = {},
): string[] {
  const model = request.model ?? defaults.model;
  const effort = request.effort ?? defaults.effort;
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(request.resumeSessionId === undefined ? [] : ['--resume', request.resumeSessionId]),
    ...(model === undefined ? [] : ['--model', model]),
    ...(effort === undefined ? [] : ['--effort', effort]),
    ...(request.maxTurns === undefined ? [] : ['--max-turns', String(request.maxTurns)]),
    ...(request.allowedTools.length === 0
      ? []
      : ['--allowedTools', claudeAllowedTools(request).join(' ')]),
    '--disallowedTools',
    claudeDisallowedTools.join(' '),
    ...(request.mcpServers === undefined || request.mcpServers.length === 0
      ? []
      : ['--mcp-config', JSON.stringify(mcpServersConfig(request)), '--strict-mcp-config']),
    ...passthroughArgs,
    '--',
    request.prompt,
  ];
}

function claudeAllowedTools(request: RunnerRequest): readonly string[] {
  return [
    ...new Set([
      ...request.allowedTools,
      ...(request.mcpServers?.some((server) => server.name === WakeMcpServerName)
        ? [`mcp__${WakeMcpServerName}`]
        : []),
    ]),
  ];
}
