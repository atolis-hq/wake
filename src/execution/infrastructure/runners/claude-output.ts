import { ClaudeAuthenticationFailureKind } from '../../../activities/index.js';
import type { AgentRunnerResult, RunnerRequest } from '../../contracts/runner.js';
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';

export const ClaudeNoFinalResultFailureKind = 'claude-no-final-result';

export function parseClaudeOutput(
  stdout: string,
  _request?: RunnerRequest,
): Partial<AgentRunnerResult> {
  const value = finalResult(stdout);
  if (value === undefined) return {};
  return {
    output: value.result,
    ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}),
    ...claudeUsage(value),
  };
}

// Deliberately narrow: only genuine provider usage/rate-limit phrasing.
// Auth/login failures (unauthorized, authentication, permission denied, api
// key) are NOT included here — they are a different failure class and must
// not be paused-and-retried as if they were transient.
const claudeQuotaPattern =
  /rate limit|quota|credit balance|spend limit|usage limit|session limit|too many requests|\b429\b/i;

const claudeAuthenticationPattern =
  /authenticate|authentication|unauthorized|oauth.*(?:expired|refresh)|session expired|not logged in|please (?:log|sign) in|invalid api key/i;

export function classifyClaudeFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  const structured = finalResult(input.stdout) ?? parseRecord(input.stdout);
  if (structured?.is_error === true && typeof structured.result === 'string') {
    const message = structured.result.trim();
    if (claudeAuthenticationPattern.test(message))
      return { kind: ClaudeAuthenticationFailureKind, message };
    if (claudeQuotaPattern.test(message))
      return { kind: ProviderQuotaExceededFailureKind, message };
    return undefined;
  }
  // Preserve plain CLI diagnostics, preferring stderr over stdout.
  const text = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  if (!claudeQuotaPattern.test(text)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: text.trim() };
}

function claudeUsage(value: Record<string, unknown>): Partial<AgentRunnerResult> {
  const usage = record(value.usage);
  const input = usage === undefined ? undefined : numeric(usage.input_tokens);
  const output = usage === undefined ? undefined : numeric(usage.output_tokens);
  if (usage === undefined || input === undefined || output === undefined) return {};
  const cacheRead = numeric(usage.cache_read_input_tokens);
  const cacheWrite = numeric(usage.cache_creation_input_tokens);
  const costUsd = numeric(value.total_cost_usd);
  return {
    tokenUsage: {
      input,
      output,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  };
}

// The last result event is authoritative; earlier ones are intermediate turns.
// A whole-output parse keeps the legacy single-object shape working.
function finalResult(stdout: string): (Record<string, unknown> & { result: string }) | undefined {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const last = lines.length === 0 ? undefined : parseRecord(lines[lines.length - 1]!);
  const value = last ?? (lines.length > 1 ? parseRecord(stdout) : undefined);
  return value !== undefined && typeof value.result === 'string'
    ? (value as Record<string, unknown> & { result: string })
    : undefined;
}

function parseRecord(stdout: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(stdout) as unknown);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
