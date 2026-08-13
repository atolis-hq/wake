import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { WorkspaceMode } from '../../contracts/vocabulary.js';
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
    ...((request.effort ?? defaults.effort) === undefined
      ? []
      : ['-c', `model_reasoning_effort=${request.effort ?? defaults.effort}`]),
    ...(request.resumeSessionId === undefined ? [] : ['resume', request.resumeSessionId]),
    ...passthroughArgs,
    request.prompt,
  ];
}

function codexSandboxMode(workspaceMode: NonNullable<RunnerRequest['workspaceMode']>) {
  return workspaceMode === WorkspaceMode.Branch ? 'danger-full-access' : 'workspace-write';
}

export function parseCodexOutput(
  stdout: string,
  request?: RunnerRequest,
): Partial<AgentRunnerResult> {
  let state: CodexOutputState = {};
  for (const line of stdout.split(/\r?\n/)) {
    state = consumeCodexEvent(state, parseLine(line));
  }
  return codexResult(state, request?.usageBaseline);
}

interface CodexOutputState {
  readonly output?: string;
  readonly sessionId?: string;
  readonly usage?: CodexUsage;
}

interface CodexUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
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
  const usage = usageFor(event);
  return {
    ...state,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(output === undefined ? {} : { output }),
    ...(usage === undefined ? {} : { usage }),
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

function usageFor(event: Record<string, unknown>): CodexUsage | undefined {
  const usage = event.type === 'turn.completed' ? asRecord(event.usage) : undefined;
  const input = usage === undefined ? undefined : numeric(usage.input_tokens);
  const output = usage === undefined ? undefined : numeric(usage.output_tokens);
  if (usage === undefined || input === undefined || output === undefined) return undefined;
  const cacheRead = numeric(asRecord(usage.input_tokens_details)?.cached_tokens);
  const cacheWrite = numeric(asRecord(usage.input_tokens_details)?.cache_creation_tokens);
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function codexResult(
  state: CodexOutputState,
  baseline: RunnerRequest['usageBaseline'],
): Partial<AgentRunnerResult> {
  const tokenUsage = codexTokenUsage(state.usage, baseline);
  return {
    ...(state.output === undefined ? {} : { output: state.output }),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
}

function codexTokenUsage(
  usage: CodexUsage | undefined,
  baseline: RunnerRequest['usageBaseline'],
): AgentRunnerResult['tokenUsage'] | undefined {
  if (usage === undefined) return undefined;
  if (baseline === undefined) return nonNegativeUsage(usage);
  if (!nonNegativeUsage(baseline)) return undefined;
  const input = subtract(usage.input, baseline.input);
  const output = subtract(usage.output, baseline.output);
  const cacheRead = cacheDelta(usage.cacheRead, baseline.cacheRead);
  const cacheWrite = cacheDelta(usage.cacheWrite, baseline.cacheWrite);
  if (
    !isRequiredDelta(input) ||
    !isRequiredDelta(output) ||
    !isOptionalDelta(cacheRead) ||
    !isOptionalDelta(cacheWrite)
  ) {
    return undefined;
  }
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function nonNegativeUsage(usage: CodexUsage): CodexUsage | undefined {
  return Object.values(usage).every((value) => Number.isFinite(value) && value >= 0)
    ? usage
    : undefined;
}

function isRequiredDelta(value: number | undefined): value is number {
  return typeof value === 'number';
}

function isOptionalDelta(value: number | 'inconsistent' | undefined): value is number | undefined {
  return value === undefined || typeof value === 'number';
}

function subtract(total: number, baseline: number): number | undefined {
  const delta = total - baseline;
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

function cacheDelta(
  total: number | undefined,
  baseline: number | undefined,
): number | 'inconsistent' | undefined {
  if (total === undefined) return baseline === undefined ? undefined : 'inconsistent';
  return subtract(total, baseline ?? 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
