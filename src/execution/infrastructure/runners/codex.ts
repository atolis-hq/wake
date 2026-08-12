import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { cliRunner, type CliRunnerOptions, type RunnerDefaults } from './claude.js';

export function createCodexRunner(options: CliRunnerOptions = {}): Runner {
  return cliRunner(
    'codex',
    options.command ?? 'codex',
    (request: RunnerRequest) => codexCommandArgs(request, options.args, options),
    {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.model === undefined ? {} : { defaultModel: options.model }),
      parseSuccessfulOutput: parseCodexOutput,
    },
  );
}

export function codexCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
  defaults: RunnerDefaults = {},
): string[] {
  const model = request.model ?? defaults.model;
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...(request.workspaceMode === undefined
      ? []
      : ['--sandbox', codexSandboxMode(request.workspaceMode)]),
    ...(request.workspacePath === undefined ? [] : ['--cd', request.workspacePath]),
    ...(model === undefined ? [] : ['--model', model]),
    ...(defaults.effort === undefined ? [] : ['-c', `model_reasoning_effort="${defaults.effort}"`]),
    ...(request.resumeSessionId === undefined ? [] : ['resume', request.resumeSessionId]),
    ...passthroughArgs,
    request.prompt,
  ];
}

function codexSandboxMode(workspaceMode: NonNullable<RunnerRequest['workspaceMode']>) {
  return workspaceMode === 'branch' ? 'danger-full-access' : 'workspace-write';
}

export function parseCodexOutput(stdout: string): Partial<AgentRunnerResult> {
  let state: CodexOutputState = {
    input: 0,
    outputTokens: 0,
    cacheRead: 0,
    sawUsage: false,
    sawCacheRead: false,
  };
  for (const line of stdout.split(/\r?\n/)) {
    state = consumeCodexEvent(state, parseLine(line));
  }
  return codexResult(state);
}

interface CodexOutputState {
  readonly output?: string;
  readonly sessionId?: string;
  readonly input: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly sawUsage: boolean;
  readonly sawCacheRead: boolean;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

function consumeCodexEvent(
  state: CodexOutputState,
  event: Record<string, unknown> | undefined,
): CodexOutputState {
  if (event === undefined) return state;
  const sessionId = sessionIdFor(event) ?? state.sessionId;
  const output = messageFor(event) ?? state.output;
  const usage = usageFor(state, event);
  return {
    ...state,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(output === undefined ? {} : { output }),
    ...(usage === undefined ? {} : usage),
  };
}

function sessionIdFor(event: Record<string, unknown>): string | undefined {
  return event.type === 'thread.started' && typeof event.thread_id === 'string'
    ? event.thread_id
    : undefined;
}

function messageFor(event: Record<string, unknown>): string | undefined {
  const item = event.type === 'item.completed' ? asRecord(event.item) : undefined;
  return item?.type === 'agent_message' && typeof item.text === 'string' ? item.text : undefined;
}

function usageFor(
  state: CodexOutputState,
  event: Record<string, unknown>,
): Partial<CodexOutputState> | undefined {
  const usage = event.type === 'turn.completed' ? asRecord(event.usage) : undefined;
  const input = usage === undefined ? undefined : numeric(usage.input_tokens);
  const outputTokens = usage === undefined ? undefined : numeric(usage.output_tokens);
  if (usage === undefined || input === undefined || outputTokens === undefined) return undefined;
  const cacheRead = numeric(asRecord(usage.input_tokens_details)?.cached_tokens);
  return {
    input: state.input + input,
    outputTokens: state.outputTokens + outputTokens,
    sawUsage: true,
    ...(cacheRead === undefined
      ? {}
      : { cacheRead: state.cacheRead + cacheRead, sawCacheRead: true }),
  };
}

function codexResult(state: CodexOutputState): Partial<AgentRunnerResult> {
  return {
    ...(state.output === undefined ? {} : { output: state.output }),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(state.sawUsage
      ? {
          tokenUsage: {
            input: state.input,
            output: state.outputTokens,
            ...(state.sawCacheRead ? { cacheRead: state.cacheRead } : {}),
          },
        }
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
