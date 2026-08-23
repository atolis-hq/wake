import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const unverifiedCodexCompletionReason =
  'unverified: could not confirm background command completion from Codex structured telemetry';

export interface CodexStopHookDecision {
  readonly decision?: 'block';
  readonly reason?: string;
}

interface ToolCall {
  readonly name: 'exec' | 'wait';
  readonly cellId?: string;
}

/**
 * Inspect only Codex's structured function-call protocol. Command output is
 * opaque except for the protocol's managed-cell and terminal-result envelopes.
 */
export function inspectCodexTranscript(transcript: string): CodexStopHookDecision {
  const telemetry: TelemetryState = {
    calls: new Map<string, ToolCall>(),
    pendingCells: new Set<string>(),
    resolvedCells: new Set<string>(),
  };

  for (const line of transcript.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const event = parseJson(line);
    if (event === undefined) return blocked('could not parse Codex structured telemetry');
    const payload = record(event.payload);
    if (payload !== undefined) consumePayload(payload, telemetry);
  }

  const unresolved = [...telemetry.pendingCells].filter(
    (cellId) => !telemetry.resolvedCells.has(cellId),
  );
  return unresolved.length === 0
    ? {}
    : blocked(`Codex cell ${unresolved[0]} has no terminal exit_code; continue polling that cell`);
}

interface TelemetryState {
  readonly calls: Map<string, ToolCall>;
  readonly pendingCells: Set<string>;
  readonly resolvedCells: Set<string>;
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
  });
}

function recordToolOutput(payload: Record<string, unknown>, telemetry: TelemetryState): void {
  const callId = string(payload.call_id);
  if (callId === undefined) return;
  const call = telemetry.calls.get(callId);
  if (call === undefined) return;
  const result = structuredResult(payload.output);
  if (call.name === 'exec') {
    if (result.exitCode === undefined && result.pendingCellId !== undefined)
      telemetry.pendingCells.add(result.pendingCellId);
    return;
  }
  if (call.cellId !== undefined && result.exitCode !== undefined)
    telemetry.resolvedCells.add(call.cellId);
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
    return blocked('could not locate Codex structured telemetry');
  const transcriptPath = await transcriptForSession(join(codexHome, 'sessions'), sessionId);
  if (transcriptPath === undefined) return blocked('could not locate Codex structured telemetry');
  return runCodexStopHook({ transcript_path: transcriptPath });
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
} {
  const texts = outputTexts(value);
  let exitCode: number | undefined;
  let pendingCellId: string | undefined;
  for (const text of texts) {
    const parsed = parseJson(text);
    const result = parsed === undefined ? undefined : record(parsed);
    const code = result === undefined ? undefined : number(result.exit_code);
    const renderedCode = /Exit code:\s*(-?\d+)/.exec(text)?.[1];
    if (code !== undefined) exitCode = code;
    else if (renderedCode !== undefined) exitCode = Number(renderedCode);
    const pending = /Script running with cell ID ([^\s]+)/.exec(text)?.[1];
    if (pending !== undefined) pendingCellId = pending;
  }
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(pendingCellId === undefined ? {} : { pendingCellId }),
  };
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
