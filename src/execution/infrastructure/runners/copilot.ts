import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunnerResult, Runner, RunnerRequest } from '../../contracts/runner.js';
import { ProviderQuotaExceededFailureKind } from '../../contracts/runner.js';
import { WorkspaceMode } from '../../contracts/vocabulary.js';
import { cliRunner, type CliRunnerOptions, type RunnerDefaults } from './claude.js';
import { mcpServersConfig } from './mcp-config.js';
import { asRecord, numeric, parseJson } from './runner-json.js';
import { usageSinceBaseline, type CumulativeUsage } from './usage-baseline.js';

// Copilot's own `session.error` categories that mean the account is out of
// budget or throttled. Authentication and policy errors are a different
// failure class and must not be paused-and-retried as if they were transient.
const copilotQuotaErrorTypes: ReadonlySet<string> = new Set(['quota', 'rate_limit']);

// Copilot drops MCP servers it is not permitted to load and still exits 0, so
// a run missing Wake's trusted servers must not be reported as a success.
export const RunnerMcpUnavailableFailureKind = 'runner-mcp-unavailable';

// An exit-zero run with no main-agent answer has nothing Wake can route on.
export const CopilotNoFinalMessageFailureKind = 'copilot-no-final-message';

const copilotCapabilities = { supportsSessionResume: true, supportsEphemeralMcp: true } as const;

// Copilot's file-editing tools, excluded for read-only runs. This is a guard
// only: the shell tool stays available and can still write, as with Claude/Codex.
const copilotEditTools = ['edit', 'create'];

export function classifyCopilotFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly kind: string; readonly message: string } | undefined {
  // Only classify from Copilot's structured error event: stdout on a failed
  // run can carry the agent's own generated text.
  for (const event of copilotEvents(input.stdout)) {
    if (event.type !== 'session.error' || event.agentId !== undefined) continue;
    const data = asRecord(event.data);
    if (typeof data?.errorType !== 'string' || typeof data.message !== 'string') continue;
    if (copilotQuotaErrorTypes.has(data.errorType))
      return { kind: ProviderQuotaExceededFailureKind, message: data.message };
  }
  return undefined;
}

export function createCopilotRunner(options: CliRunnerOptions = {}): Runner {
  const runnerFor = (usageFile: string) =>
    cliRunner(
      'copilot',
      options.command ?? 'copilot',
      (request: RunnerRequest) => copilotCommandArgs(request, options.args, options, usageFile),
      {
        ...(options.runnerTimeouts === undefined ? {} : { runnerTimeouts: options.runnerTimeouts }),
        ...(options.model === undefined ? {} : { defaultModel: options.model }),
        rejectSuccessfulExit: copilotMcpFailure,
        parseSuccessfulOutput: (stdout, request) =>
          parseCopilotOutput(stdout, request, readUsageReport(usageFile)),
        classifyFailure: classifyCopilotFailure,
        unparsedSuccessFailure: {
          kind: CopilotNoFinalMessageFailureKind,
          message: 'Copilot exited successfully without a final assistant message',
        },
        ...copilotCapabilities,
      },
    );
  return {
    ...copilotCapabilities,
    async start(request, signal) {
      // Copilot reports token counts only through its usage file, not stdout.
      const usageFile = join(tmpdir(), `wake-copilot-usage-${randomUUID()}.json`);
      const execution = await runnerFor(usageFile).start(request, signal);
      return {
        ...execution,
        result: execution.result.finally(() => rm(usageFile, { force: true })),
      };
    },
  };
}

export function copilotCommandArgs(
  request: RunnerRequest,
  passthroughArgs: readonly string[] = [],
  defaults: RunnerDefaults = {},
  usageFile?: string,
): string[] {
  const model = request.model ?? defaults.model;
  const effort = request.effort ?? defaults.effort;
  return [
    // The `=` form keeps a prompt starting with `-` from parsing as a flag.
    `--prompt=${request.prompt}`,
    '--output-format',
    'json',
    // Wake executes runners inside its Docker sandbox, as with Codex.
    '--allow-all',
    '--no-ask-user',
    '--no-auto-update',
    ...(model === undefined ? [] : ['--model', model]),
    ...(effort === undefined ? [] : ['--reasoning-effort', effort]),
    ...(request.workspaceMode === WorkspaceMode.ReadOnly
      ? [`--excluded-tools=${copilotEditTools.join(',')}`]
      : []),
    ...(request.mcpServers === undefined || request.mcpServers.length === 0
      ? []
      : ['--additional-mcp-config', JSON.stringify(mcpServersConfig(request))]),
    ...(request.resumeSessionId === undefined ? [] : [`--resume=${request.resumeSessionId}`]),
    ...(usageFile === undefined ? [] : ['--usage-output-file', usageFile]),
    ...passthroughArgs,
  ];
}

// Fails only on evidence: Copilot emitted a loaded-server report and no
// report shows a requested server connected.
export function copilotMcpFailure(
  stdout: string,
  request: RunnerRequest,
): { readonly kind: string; readonly message: string } | undefined {
  const requested = (request.mcpServers ?? []).map((server) => server.name);
  if (requested.length === 0) return undefined;
  const events = [...copilotEvents(stdout)];
  const reports = events
    .filter((event) => event.type === 'session.mcp_servers_loaded')
    .map((event) => asRecord(event.data)?.servers)
    .filter(Array.isArray);
  if (reports.length === 0) return undefined;
  const listed = reports.flat().map(asRecord);
  const connected = new Set(
    listed.filter((server) => server?.status === 'connected').map((server) => server?.name),
  );
  const missing = requested.filter((name) => !connected.has(name));
  if (missing.length === 0) return undefined;
  // A server that was listed but failed carries Copilot's own reason.
  const errors = listed
    .filter((server) => missing.includes(String(server?.name)) && typeof server?.error === 'string')
    .map((server) => `${String(server?.name)}: ${String(server?.error)}`);
  const warnings = events
    .filter((event) => event.type === 'session.warning')
    .map((event) => asRecord(event.data)?.message)
    .filter((message): message is string => typeof message === 'string');
  return {
    kind: RunnerMcpUnavailableFailureKind,
    message: [
      `Copilot did not connect MCP server(s): ${missing.join(', ')}`,
      ...errors,
      ...warnings,
    ].join('\n'),
  };
}

export function parseCopilotOutput(
  stdout: string,
  request?: RunnerRequest,
  usageReport?: string,
): Partial<AgentRunnerResult> {
  // Sub-agent events carry an agentId; only the main agent's answer counts.
  const events = [...copilotEvents(stdout)].filter((event) => event.agentId === undefined);
  const output = events.map(messageContent).filter(isDefined).at(-1);
  const sessionId = events.map(resultSessionId).filter(isDefined).at(-1);
  const tokenUsage = usageSinceBaseline(
    usageReport === undefined ? undefined : copilotUsage(usageReport),
    request?.usageBaseline,
  );
  return {
    ...(output === undefined ? {} : { output }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function messageContent(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'assistant.message') return undefined;
  const content = asRecord(event.data)?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : undefined;
}

function resultSessionId(event: Record<string, unknown>): string | undefined {
  return event.type === 'result' && typeof event.sessionId === 'string'
    ? event.sessionId
    : undefined;
}

// The usage file is a cumulative snapshot for the whole session, summed
// across every model the session used.
function copilotUsage(report: string): CumulativeUsage | undefined {
  const models = asRecord(asRecord(parseJson(report))?.modelMetrics);
  if (models === undefined) return undefined;
  const usages = Object.values(models).map(modelUsage);
  if (usages.length === 0 || usages.some((usage) => usage === undefined)) return undefined;
  return (usages as CumulativeUsage[]).reduce((total, usage) => ({
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: (total.cacheRead ?? 0) + (usage.cacheRead ?? 0),
    cacheWrite: (total.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
  }));
}

// Copilot's `inputTokens` already includes cached tokens, while Wake sums every
// counter; report the uncached remainder so cache reads are not counted twice.
function modelUsage(model: unknown): CumulativeUsage | undefined {
  const usage = asRecord(asRecord(model)?.usage);
  const total = numeric(usage?.inputTokens);
  const output = numeric(usage?.outputTokens);
  if (total === undefined || output === undefined) return undefined;
  const cacheRead = numeric(usage?.cacheReadTokens) ?? 0;
  const cacheWrite = numeric(usage?.cacheWriteTokens) ?? 0;
  const input = total - cacheRead - cacheWrite;
  if (input < 0) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function readUsageReport(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function* copilotEvents(stdout: string): Generator<Record<string, unknown>> {
  for (const line of stdout.split(/\r?\n/)) {
    const event = asRecord(parseJson(line.trim()));
    if (event !== undefined) yield event;
  }
}
