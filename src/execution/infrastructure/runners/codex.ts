import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';
import { cliRunner, type CliRunnerOptions, type RunnerDefaults } from './cli-runner.js';
import { asRecord, numeric, parseJsonRecord } from './runner-json.js';
import { usageSinceBaseline, type CumulativeUsage } from './usage-baseline.js';

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
    const event = parseJsonRecord(trimmed);
    if (event === undefined) continue;
    if (event.type === 'error' && typeof event.message === 'string') return event.message;
    if (event.type === 'turn.failed') {
      const error = asRecord(event.error);
      if (typeof error?.message === 'string') return error.message;
    }
  }
  return undefined;
}

export type CodexRunnerOptions = CliRunnerOptions;

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
      supportsEphemeralMcp: true,
    },
  );
  return runner;
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
    '--sandbox',
    CODEX_SANDBOX_MODE,
    ...(request.workspacePath === undefined ? [] : ['--cd', request.workspacePath]),
    ...(model === undefined ? [] : ['--model', model]),
    ...((request.effort ?? defaults.effort) === undefined
      ? []
      : ['-c', `model_reasoning_effort=${request.effort ?? defaults.effort}`]),
    ...codexMcpConfigArgs(request),
    ...(request.resumeSessionId === undefined ? [] : ['resume', request.resumeSessionId]),
    ...passthroughArgs,
    `${request.prompt}\n\n${waitBackgroundInstruction}`,
  ];
}

function codexMcpConfigArgs(request: RunnerRequest): readonly string[] {
  return (request.mcpServers ?? []).flatMap((server) => [
    '-c',
    `mcp_servers.${server.name}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args ?? [])}${
      server.env === undefined
        ? ''
        : `,env={${Object.entries(server.env)
            .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
            .join(',')}}`
    }}`,
  ]);
}

// Work around Codex's missing background-command lifecycle contract (https://github.com/openai/codex/issues/32505, https://github.com/openai/codex/issues/34866).
const waitBackgroundInstruction = `When a command you started is still running or lacks a terminal result, do not report a normal Wake outcome. Make your entire final response exactly WAIT_BACKGROUND. Wake will reject that stop attempt and ask you to continue. After that hook prompt, poll the still-running command and report a normal terminal status only after it has settled. Do not use WAIT_BACKGROUND for a human-input or implementation blocker.`;

// Wake executes runners inside its Docker sandbox. Avoid asking Codex to
// create a second Linux namespace sandbox, which container runtimes may deny.
// Applies to stages without a workspace too: Codex's default sandbox cannot
// start here and denies MCP tool approvals under non-interactive exec.
const CODEX_SANDBOX_MODE = 'danger-full-access';

export function parseCodexOutput(
  stdout: string,
  request?: RunnerRequest,
): Partial<AgentRunnerResult> {
  let state: CodexOutputState = {};
  for (const line of stdout.split(/\r?\n/)) {
    state = consumeCodexEvent(state, parseJsonRecord(line));
  }
  return codexResult(state, request?.usageBaseline);
}

interface CodexOutputState {
  readonly output?: string;
  readonly sessionId?: string;
  readonly usage?: CodexUsage;
}

type CodexUsage = CumulativeUsage;

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
  const tokenUsage = usageSinceBaseline(state.usage, baseline);
  return {
    ...(state.output === undefined ? {} : { output: state.output }),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
}
