import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';
import { RunStatus, WorkspaceMode } from '../../contracts/vocabulary.js';
import { verifyCodexSession } from '../codex-stop-hook.js';
import { cliRunner, type CliRunnerOptions, type RunnerDefaults } from './claude.js';

// Deliberately narrow: only genuine provider usage/rate-limit phrasing.
// Auth/login failures (unauthorized, authentication, api key, not logged
// in, login required) are NOT included here — they are a different failure
// class and must not be paused-and-retried as if they were transient.
const codexQuotaPattern =
  /usage limit|rate limit|quota|too many requests|credit balance|spend limit|session limit|\b429\b/i;

export function classifyCodexFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  // Only ever classify from Codex's own structured error/turn.failed
  // message, never from scanning raw stdout — stdout on a failed run can
  // carry the agent's own generated text, which must never be
  // pattern-matched into a false quota classification.
  const structured = extractCodexErrorMessage(input.stdout);
  if (structured === undefined) return undefined;
  if (!codexQuotaPattern.test(structured)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: structured };
}

function extractCodexErrorMessage(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const event = parseLine(trimmed);
    if (event === undefined) continue;
    if (event.type === 'error' && typeof event.message === 'string') return event.message;
    if (event.type === 'turn.failed') {
      const error = asRecord(event.error);
      if (typeof error?.message === 'string') return error.message;
    }
  }
  return undefined;
}

export interface CodexRunnerOptions extends CliRunnerOptions {
  readonly codexHome?: string;
}

export function createCodexRunner(options: CodexRunnerOptions = {}): Runner {
  const runner = cliRunner(
    'codex',
    options.command ?? 'codex',
    (request: RunnerRequest) => codexCommandArgs(request, options.args, options),
    {
      ...(options.runnerTimeouts === undefined ? {} : { runnerTimeouts: options.runnerTimeouts }),
      ...(options.model === undefined ? {} : { defaultModel: options.model }),
      parseSuccessfulOutput: parseCodexOutput,
      classifyFailure: classifyCodexFailure,
      supportsSessionResume: true,
    },
  );
  return {
    supportsSessionResume: true,
    async start(request, signal) {
      const execution = await runner.start(request, signal);
      return {
        ...execution,
        result: execution.result.then(async (result) => {
          if (result.transport !== RunStatus.Succeeded) return result;
          const decision = await verifyCodexSession(
            options.codexHome ?? process.env.CODEX_HOME,
            result.sessionId,
          );
          return decision.decision === undefined
            ? result
            : { ...result, unverifiedCompletionReason: decision.reason };
        }),
      };
    },
  };
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
