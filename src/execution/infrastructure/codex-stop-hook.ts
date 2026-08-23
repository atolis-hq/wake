import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const unverifiedCodexCompletionReason =
  'unverified: could not confirm background command completion from Codex structured telemetry';

export interface CodexStopHookDecision {
  readonly decision?: 'block';
  readonly reason?: string;
}

/**
 * Bound on how long this hook will keep forcing continuation for the same
 * unresolved cell within one process segment before giving up and letting
 * the turn end anyway. A retry *count* doesn't track this reliably — cycle
 * length varies enormously with how long the model's own `wait` calls choose
 * to yield for (observed from ~1s to 50s+ per call in production), so a
 * fixed count either gives up far too early on a real multi-minute command
 * or far too late on a broken loop that isn't waiting on anything real.
 *
 * Real observed `npm run verify`/`verify:ci` durations range from ~90s to
 * over 20 minutes, so this value is a deliberate tradeoff rather than a safe
 * upper bound on every legitimate case: a genuinely long-running command that
 * outlasts it will have its live retry loop give up before finishing, and
 * fall through to a `BLOCKED` outcome needing a human `/retry` instead of
 * confirming cleanly on its own. That's an accepted cost, not a correctness
 * gap — giving up here never weakens the guarantee, since the post-run
 * fallback (`verifyCodexSession`) independently re-scans the same transcript
 * after the process exits and still reports the run as unverified if the
 * cell is genuinely still unresolved. This limit exists only to bound
 * wasted time/tokens against a detection gap we haven't found yet, not to
 * replace correct detection.
 */
export const maxLiveHookRetryMs = 10 * 60 * 1000;

interface ToolCall {
  readonly name: 'exec' | 'wait';
  readonly cellId?: string;
  readonly spawnsBackgroundJob?: boolean;
}

/**
 * Inspect only Codex's structured function-call protocol. Command output is
 * opaque except for the protocol's managed-cell and terminal-result envelopes.
 *
 * Exec/wait cells live in one `codex exec` process's memory and never survive
 * a resume into a new process, so only the segment of the transcript since
 * the current process attached (its `session_meta`/`turn_context` marker)
 * can hold a cell that might still be genuinely pending. A cell referenced
 * only in an earlier segment belongs to a process that has already exited
 * and can never return an exit code again — scoping to the latest segment
 * is what makes that structurally certain, rather than trying to recognise
 * every shape of "this cell is gone" text a stale reference might produce.
 */
export function inspectCodexTranscript(transcript: string): CodexStopHookDecision {
  const lines = transcript.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const boundary = lastProcessBoundary(lines);
  const telemetry: TelemetryState = {
    calls: new Map<string, ToolCall>(),
    pendingCells: new Set<string>(),
    resolvedCells: new Set<string>(),
    unresolvableCells: new Set<string>(),
  };

  for (const line of lines.slice(boundary + 1)) {
    const event = parseJson(line);
    if (event === undefined) return blocked('could not parse Codex structured telemetry');
    const payload = record(event.payload);
    if (payload !== undefined) consumePayload(payload, telemetry);
  }

  const unresolved = [...telemetry.pendingCells].filter(
    (cellId) => !telemetry.resolvedCells.has(cellId),
  );
  if (unresolved.length === 0) return {};

  // A cell whose own `wait` call has already reported it gone (a distinct,
  // cell-identity-specific protocol error, not a general failure) can never
  // return an exit code no matter how many more times it's polled. Asking
  // the model to keep retrying it is not just wasted effort, it's actively
  // wrong instructions — so stop retrying that specific cell immediately
  // rather than waiting out the general time backstop. The cell still
  // counts as unresolved for the block decision itself: it genuinely never
  // confirmed completion, it just isn't worth telling the model to poll
  // again.
  const retryable = unresolved.filter((cellId) => !telemetry.unresolvableCells.has(cellId));
  if (retryable.length === 0) return {};

  if (liveHookRetryElapsedMs(lines.slice(boundary + 1)) >= maxLiveHookRetryMs) return {};
  return blocked(
    `Codex cell ${retryable[0]} has no terminal exit_code; continue polling that cell`,
  );
}

/**
 * Elapsed wall-clock time since this hook's own first continuation prompt
 * within the current process segment, using the transcript's own event
 * timestamps rather than a call/retry count. Returns 0 (never give up) when
 * there is no prior retry yet, or when a timestamp can't be established —
 * giving up is the direction that stops enforcing, so any doubt should keep
 * blocking rather than silently switch to time-based give-up on weak evidence.
 */
function liveHookRetryElapsedMs(segment: readonly string[]): number {
  let firstRetryAt: number | undefined;
  let latestAt: number | undefined;
  for (const line of segment) {
    const event = parseJson(line);
    if (event === undefined) continue;
    const at = timestampMs(event.timestamp);
    if (at !== undefined) latestAt = at;
    const payload = record(event.payload);
    if (payload?.type !== 'message' || payload.role !== 'user') continue;
    if (
      firstRetryAt === undefined &&
      at !== undefined &&
      userMessageText(payload.content).includes('<hook_prompt')
    )
      firstRetryAt = at;
  }
  return firstRetryAt === undefined || latestAt === undefined ? 0 : latestAt - firstRetryAt;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function userMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const entry = record(item);
      return entry === undefined ? '' : (string(entry.text) ?? '');
    })
    .join('');
}

function lastProcessBoundary(lines: readonly string[]): number {
  let boundary = -1;
  lines.forEach((line, index) => {
    const event = parseJson(line);
    if (event?.type === 'session_meta' || event?.type === 'turn_context') boundary = index;
  });
  return boundary;
}

interface TelemetryState {
  readonly calls: Map<string, ToolCall>;
  readonly pendingCells: Set<string>;
  readonly resolvedCells: Set<string>;
  readonly unresolvableCells: Set<string>;
}

function consumePayload(payload: Record<string, unknown>, telemetry: TelemetryState): void {
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    recordToolCall(payload, telemetry.calls);
    return;
  }
  if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output')
    recordToolOutput(payload, telemetry);
}

function recordToolCall(payload: Record<string, unknown>, calls: Map<string, ToolCall>): void {
  const callId = string(payload.call_id);
  const name = toolName(payload.name);
  if (callId === undefined || name === undefined) return;
  calls.set(callId, {
    name,
    ...(name === 'wait' ? cellArgument(payload.arguments ?? payload.input) : {}),
    ...(name === 'exec' ? { spawnsBackgroundJob: spawnsBackgroundJob(payload.input) } : {}),
  });
}

/**
 * The `exec` tool is a shared JS sandbox: `tools.exec_command(...)` spawns a
 * genuine one-shot background job whose cell should eventually resolve to a
 * real exit code. `tools.write_stdin(...)` instead interacts with an
 * already-existing, intentionally long-lived session (e.g. a dev server kept
 * running for e2e checks) — that cell is never meant to terminate, so
 * flagging it as an unresolved background command would be a false positive.
 * Default to treating a call as job-spawning whenever it can't be positively
 * identified as pure session interaction, matching the fail-closed posture
 * used everywhere else in this file.
 */
function spawnsBackgroundJob(input: unknown): boolean {
  if (typeof input !== 'string') return true;
  const interactsWithSession = /tools\.write_stdin\s*\(/.test(input);
  const spawnsJob = /tools\.exec_command\s*\(/.test(input);
  return spawnsJob || !interactsWithSession;
}

function recordToolOutput(payload: Record<string, unknown>, telemetry: TelemetryState): void {
  const callId = string(payload.call_id);
  if (callId === undefined) return;
  const call = telemetry.calls.get(callId);
  if (call === undefined) return;
  const result = structuredResult(payload.output);
  if (call.name === 'exec') {
    if (
      call.spawnsBackgroundJob === true &&
      result.exitCode === undefined &&
      result.pendingCellId !== undefined
    )
      telemetry.pendingCells.add(result.pendingCellId);
    return;
  }
  if (call.cellId === undefined) return;
  if (result.exitCode !== undefined) telemetry.resolvedCells.add(call.cellId);
  if (result.notFoundCellId === call.cellId) telemetry.unresolvableCells.add(call.cellId);
}

export async function runCodexStopHook(input: unknown): Promise<CodexStopHookDecision> {
  const payload = record(input);
  const transcriptPath = payload === undefined ? undefined : string(payload.transcript_path);
  if (transcriptPath === undefined) return blocked('Stop hook received no transcript_path');
  try {
    return inspectCodexTranscript(await readFile(transcriptPath, 'utf8'));
  } catch {
    return blocked('could not read Codex transcript');
  }
}

export async function verifyCodexSession(
  codexHome: string | undefined,
  sessionId: string | undefined,
): Promise<CodexStopHookDecision> {
  if (codexHome === undefined || sessionId === undefined)
    return postRunBlocked('could not locate Codex structured telemetry');
  const transcriptPath = await transcriptForSession(join(codexHome, 'sessions'), sessionId);
  if (transcriptPath === undefined)
    return postRunBlocked('could not locate Codex structured telemetry');
  return postRunDecision(await runCodexStopHook({ transcript_path: transcriptPath }));
}

async function transcriptForSession(
  directory: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await transcriptForSession(path, sessionId);
        if (nested !== undefined) return nested;
      } else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) return path;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function structuredResult(value: unknown): {
  readonly exitCode?: number;
  readonly pendingCellId?: string;
  readonly notFoundCellId?: string;
} {
  const texts = outputTexts(value);
  let exitCode: number | undefined;
  let pendingCellId: string | undefined;
  let notFoundCellId: string | undefined;
  for (const text of texts) {
    exitCode = exitCodeInText(text) ?? exitCode;
    pendingCellId = /Script running with cell ID ([^\s]+)/.exec(text)?.[1] ?? pendingCellId;
    // A cell-identity-specific protocol error: the runtime has discarded
    // this cell's bookkeeping and no exit code will ever be available for
    // it, distinct from a generic tool/script failure with a real message.
    notFoundCellId = /exec cell ([^\s]+) not found/.exec(text)?.[1] ?? notFoundCellId;
  }
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(pendingCellId === undefined ? {} : { pendingCellId }),
    ...(notFoundCellId === undefined ? {} : { notFoundCellId }),
  };
}

function exitCodeInText(text: string): number | undefined {
  const result = parseJson(text);
  const code = result === undefined ? undefined : number(result.exit_code);
  if (code !== undefined) return code;
  const rendered = /Exit code:\s*(-?\d+)/.exec(text)?.[1];
  return rendered === undefined ? undefined : Number(rendered);
}

function outputTexts(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const content = record(item);
    const text = content === undefined ? undefined : string(content.text);
    return text === undefined ? [] : [text];
  });
}

function cellArgument(value: unknown): { readonly cellId?: string } {
  const arguments_ = typeof value === 'string' ? parseJson(value) : record(value);
  const cellId = arguments_ === undefined ? undefined : string(arguments_.cell_id);
  return cellId === undefined ? {} : { cellId };
}

function blocked(detail: string): CodexStopHookDecision {
  return { decision: 'block', reason: `${unverifiedCodexCompletionReason}: ${detail}` };
}

function postRunBlocked(detail: string): CodexStopHookDecision {
  return postRunDecision(blocked(detail));
}

function postRunDecision(decision: CodexStopHookDecision): CodexStopHookDecision {
  return decision.decision === 'block' && decision.reason !== undefined
    ? { ...decision, reason: `caught by post-run verification: ${decision.reason}` }
    : decision;
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function toolName(value: unknown): 'exec' | 'wait' | undefined {
  return value === 'exec' || value === 'wait' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const payload = parseJson(input);
    void runCodexStopHook(payload).then((decision) =>
      process.stdout.write(JSON.stringify(decision)),
    );
  });
}
