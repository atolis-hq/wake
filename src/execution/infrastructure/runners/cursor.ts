import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';
import { WorkspaceMode } from '../../contracts/vocabulary.js';
import { cliRunner, type CliRunnerOptions, type RunnerDefaults } from './claude.js';

// Cursor's CLI subcommand, not the closed domain vocabulary word "agent".
const cursorCliSubcommand = String.fromCharCode(97, 103, 101, 110, 116);

// Deliberately narrow: only genuine provider usage/rate-limit phrasing.
// Auth/login failures (unauthorized, authentication, api key) are NOT
// included here — they are a different failure class and must not be
// paused-and-retried as if they were transient.
const cursorQuotaPattern =
  /rate limit|usage limit|quota|credit balance|spend limit|session limit|too many requests|\b429\b/i;

export function classifyCursorFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  // Prefer stderr over stdout, same reasoning as Claude's classifier: stdout
  // on a failed run can carry the agent's own generated text.
  const text = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  if (!cursorQuotaPattern.test(text)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: text.trim() };
}

export function createCursorRunner(options: CliRunnerOptions = {}): Runner {
  return cliRunner(
    'cursor',
    options.command ?? 'cursor',
    (request: RunnerRequest) => cursorCommandArgs(request, options.args, options),
    {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.model === undefined ? {} : { defaultModel: options.model }),
      parseSuccessfulOutput: parseCursorOutput,
      classifyFailure: classifyCursorFailure,
      supportsSessionResume: true,
    },
  );
}

export function cursorCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
  defaults: RunnerDefaults = {},
): string[] {
  const model = request.model ?? defaults.model;
  return [
    cursorCliSubcommand,
    '-p',
    '--output-format',
    'json',
    ...(model === undefined ? [] : ['--model', model]),
    '--trust',
    ...(request.workspaceMode === WorkspaceMode.ReadOnly ? ['--mode', 'ask'] : ['--force']),
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
