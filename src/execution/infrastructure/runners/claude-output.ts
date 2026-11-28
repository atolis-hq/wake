import {
  ClaudeAuthenticationFailureKind,
  RunnerAuthenticationMessage,
} from '../../../activities/index.js';
import type { AgentRunnerResult, RunnerRequest } from '../../contracts/runner.js';
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';
import { asRecord, numeric, parseJsonRecord } from './runner-json.js';

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
  /rate limit|quota|credit balance|spend limit|usage limit|session limit|too many requests|\b429\b|\bhit your [\w -]*limit\b/i;

// The CLI's result text changes ("You've hit your 5-hour limit"); its API error fields do not.
function reportsClaudeRateLimit(result: Record<string, unknown>): boolean {
  return (
    result.api_error_status === 429 ||
    result.api_error_type === 'rate_limit_error' ||
    result.api_error === 'usage_limit_reached'
  );
}

const claudeAuthenticationPattern =
  /authenticate|authentication|unauthorized|oauth.*(?:expired|refresh)|session expired|not logged in|please (?:log|sign) in|invalid api key/i;

export function classifyClaudeFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  const structured = finalResult(input.stdout) ?? parseJsonRecord(input.stdout);
  if (structured?.is_error === true && typeof structured.result === 'string') {
    const message = structured.result.trim();
    if (claudeAuthenticationPattern.test(message))
      return { kind: ClaudeAuthenticationFailureKind, message: RunnerAuthenticationMessage };
    if (claudeQuotaPattern.test(message) || reportsClaudeRateLimit(structured))
      return { kind: ProviderQuotaExceededFailureKind, message };
    return undefined;
  }
  // Preserve plain CLI diagnostics, preferring stderr over stdout.
  const text = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  if (!claudeQuotaPattern.test(text)) return undefined;
  return { kind: ProviderQuotaExceededFailureKind, message: text.trim() };
}

function claudeUsage(value: Record<string, unknown>): Partial<AgentRunnerResult> {
  const usage = asRecord(value.usage);
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
  const last = lines.length === 0 ? undefined : parseJsonRecord(lines[lines.length - 1]!);
  const value = last ?? (lines.length > 1 ? parseJsonRecord(stdout) : undefined);
  return value !== undefined && typeof value.result === 'string'
    ? (value as Record<string, unknown> & { result: string })
    : undefined;
}
