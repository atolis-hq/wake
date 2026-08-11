import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

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
    'agent',
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return {};
  }
  const value = asRecord(parsed);
  if (value === undefined) return {};
  if (typeof value.result !== 'string') return {};
  const usage = asRecord(value.usage);
  const input = usage === undefined ? undefined : numeric(usage.inputTokens);
  const output = usage === undefined ? undefined : numeric(usage.outputTokens);
  const cacheRead = usage === undefined ? undefined : numeric(usage.cacheReadTokens);
  const cacheWrite = usage === undefined ? undefined : numeric(usage.cacheWriteTokens);
  return {
    output: value.result,
    ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}),
    ...(input === undefined || output === undefined
      ? {}
      : {
          tokenUsage: {
            input,
            output,
            ...(cacheRead === undefined ? {} : { cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWrite }),
          },
        }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
