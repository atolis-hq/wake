import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const waitBackgroundStatus = 'WAIT_BACKGROUND';

export interface CodexStopHookDecision {
  readonly decision?: 'block';
  readonly reason?: string;
}

/**
 * WAIT_BACKGROUND is a Codex-only, intermediate final response. It is not a
 * Wake outcome: the hook rejects it and gives Codex another turn to obtain a
 * terminal result before it reports DONE, BLOCKED, NEEDS_CLARIFICATION, or
 * FAILED.
 */
export function inspectCodexTranscript(transcript: string): CodexStopHookDecision {
  return lastAssistantMessage(transcript) === waitBackgroundStatus
    ? {
        decision: 'block',
        reason:
          'Codex reported WAIT_BACKGROUND. Do not end this turn. Poll every command still running from this turn and report a normal terminal status only after each has settled.',
      }
    : {};
}

export async function runCodexStopHook(input: unknown): Promise<CodexStopHookDecision> {
  const payload = record(input);
  const transcriptPath = payload === undefined ? undefined : string(payload.transcript_path);
  if (transcriptPath === undefined) return {};
  try {
    return inspectCodexTranscript(await readFile(transcriptPath, 'utf8'));
  } catch {
    return {};
  }
}

function lastAssistantMessage(transcript: string): string | undefined {
  const lines = transcript.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = parseJson(lines[index] ?? '');
    const payload = event === undefined ? undefined : record(event.payload);
    if (
      payload?.type !== 'message' ||
      payload.role !== 'assistant' ||
      payload.phase !== 'final_answer'
    )
      continue;
    return messageText(payload.content);
  }
  return undefined;
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content.map((item) => {
    const entry = record(item);
    if (entry?.type !== 'output_text') return undefined;
    return string(entry.text);
  });
  return texts.every((text) => text !== undefined) ? texts.join('') : undefined;
}

function parseJson(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
