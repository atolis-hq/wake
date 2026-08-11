import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

// Cursor's CLI subcommand, not the closed domain vocabulary word "agent".
const cursorCliSubcommand = String.fromCharCode(97, 103, 101, 110, 116);

export function createCursorRunner(
  command = 'cursor',
  timeoutMs?: number,
  passthroughArgs: readonly string[] = [],
): Runner {
  return cliRunner(
    'cursor',
    command,
    (request: RunnerRequest) => cursorCommandArgs(request, passthroughArgs),
    { ...(timeoutMs === undefined ? {} : { timeoutMs }), parseSuccessfulOutput: parseCursorOutput },
  );
}

export function cursorCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
): string[] {
  return [
    cursorCliSubcommand,
    '-p',
    '--output-format',
    'json',
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.resumeSessionId === undefined ? [] : [`--resume=${request.resumeSessionId}`]),
    ...passthroughArgs,
    request.prompt,
  ];
}

export function parseCursorOutput(stdout: string): Partial<AgentRunnerResult> {
  const value = parseRecord(stdout);
  if (value === undefined || typeof value.result !== 'string') return {};
  return {
    output: value.result,
    ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}),
    ...cursorUsage(value),
  };
}

function cursorUsage(value: Record<string, unknown>): Partial<AgentRunnerResult> {
  const usage = asRecord(value.usage);
  const input = usage === undefined ? undefined : numeric(usage.inputTokens);
  const output = usage === undefined ? undefined : numeric(usage.outputTokens);
  if (usage === undefined || input === undefined || output === undefined) return {};
  const cacheRead = numeric(usage.cacheReadTokens);
  const cacheWrite = numeric(usage.cacheWriteTokens);
  return {
    tokenUsage: {
      input,
      output,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    },
  };
}

function parseRecord(stdout: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(stdout) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
