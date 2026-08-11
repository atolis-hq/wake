import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner } from './claude.js';

export function createCodexRunner(
  command = 'codex',
  timeoutMs?: number,
  passthroughArgs: readonly string[] = [],
): Runner {
  return cliRunner(
    'codex',
    command,
    (request: RunnerRequest) => codexCommandArgs(request, passthroughArgs),
    { ...(timeoutMs === undefined ? {} : { timeoutMs }), parseSuccessfulOutput: parseCodexOutput },
  );
}

export function codexCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
): string[] {
  return [
    'exec',
    '--json',
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.resumeSessionId === undefined ? [] : ['resume', request.resumeSessionId]),
    ...passthroughArgs,
    request.prompt,
  ];
}

export function parseCodexOutput(stdout: string): Partial<AgentRunnerResult> {
  let output: string | undefined;
  let sessionId: string | undefined;
  let sawUsage = false;
  let input = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let sawCacheRead = false;

  for (const line of stdout.split(/\r?\n/)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const event = asRecord(parsed);
    if (event === undefined) continue;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
    }
    if (event.type === 'item.completed') {
      const item = asRecord(event.item);
      if (item?.type === 'agent_message' && typeof item.text === 'string') output = item.text;
    }
    if (event.type === 'turn.completed') {
      const usage = asRecord(event.usage);
      const turnInput = usage === undefined ? undefined : numeric(usage.input_tokens);
      const turnOutput = usage === undefined ? undefined : numeric(usage.output_tokens);
      if (usage !== undefined && turnInput !== undefined && turnOutput !== undefined) {
        sawUsage = true;
        input += turnInput;
        outputTokens += turnOutput;
        const turnCacheRead = numeric(asRecord(usage.input_tokens_details)?.cached_tokens);
        if (turnCacheRead !== undefined) {
          cacheRead += turnCacheRead;
          sawCacheRead = true;
        }
      }
    }
  }
  return {
    ...(output === undefined ? {} : { output }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sawUsage
      ? { tokenUsage: { input, output: outputTokens, ...(sawCacheRead ? { cacheRead } : {}) } }
      : {}),
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
