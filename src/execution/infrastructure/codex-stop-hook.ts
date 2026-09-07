import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const waitBackgroundStatus = 'WAIT_BACKGROUND';

export const humanInputRequiredMarker = 'WAKE_HUMAN_INPUT_REQUIRED:';

export interface CodexStopHookDecision {
  readonly decision?: 'block';
  readonly reason?: string;
}

/**
 * WAIT_BACKGROUND and an unexplained blocked result are intermediate final
 * responses. They are not Wake outcomes: the hook rejects them and gives
 * Codex another turn to obtain a terminal result.
 */
export function inspectCodexTranscript(transcript: string): CodexStopHookDecision {
  const message = lastAssistantMessage(transcript);
  if (message === undefined) return {};
  if (message === waitBackgroundStatus)
    return {
      decision: 'block',
      reason:
        'Codex reported WAIT_BACKGROUND. Do not end this turn. Poll every command still running from this turn and report a normal terminal status only after each has settled.',
    };
  if (blockedWithoutHumanAction(message))
    return {
      decision: 'block',
      reason:
        'A BLOCKED or NEEDS_CLARIFICATION result requires a concrete human action. Unfinished implementation, unrun verification, or remaining tests are not human blockers. Continue working; only stop with that status after including a WAKE_HUMAN_INPUT_REQUIRED: line that names the decision or action needed.',
    };
  return {};
}

function blockedWithoutHumanAction(message: string): boolean {
  const status = terminalStatus(message);
  return (
    (status === 'BLOCKED' || status === 'NEEDS_CLARIFICATION') &&
    !message
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim().startsWith(humanInputRequiredMarker) &&
          line.trim().length > humanInputRequiredMarker.length,
      )
  );
}

function terminalStatus(message: string): string | undefined {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
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
