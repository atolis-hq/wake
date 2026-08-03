import type { AgentRunOutcome, AgentRunResponse, AgentRunnerResult } from '../contracts/runner.js';
import { RunStatus } from '../contracts/vocabulary.js';

export function parseAgentRunnerResponse(result: AgentRunnerResult): AgentRunResponse {
  const parsed = parseResult(result.output);
  return {
    outcome: result.transport === RunStatus.Succeeded ? parsed.outcome : 'FAILED',
    displayBody:
      result.transport === RunStatus.Succeeded
        ? parsed.displayBody
        : result.failure?.message || parsed.displayBody || 'Runner failed without a response.',
    metadata: metadata(result),
  };
}

function parseResult(output: string): { readonly outcome: AgentRunOutcome; readonly displayBody: string } {
  const direct = parseEnvelope(output);
  if (direct !== undefined) return { outcome: direct, displayBody: synthesized(direct) };
  const fence = /^```(?:wake-result[^\n]*\n|[ \t]*\n[ \t]*wake-result[ \t]*\n)([\s\S]*?)^```[ \t]*$/gm;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(output)) !== null) last = match;
  if (last !== null) {
    try {
      const json = (last[1] ?? '').replace(/\n(?:DONE|REJECTED|BLOCKED|FAILED)[ \t]*\n?$/, '');
      const value = JSON.parse(json) as { status?: unknown };
      if (isOutcome(value.status))
        return { outcome: value.status, displayBody: output.slice(0, last.index).trim() || synthesized(value.status) };
    } catch {
      // A malformed envelope intentionally falls through to the legacy sentinel rules.
    }
  }
  const lines = output.split('\n');
  const lastLine = lines.map((line) => line.trim()).filter((line) => line.length > 0 && line !== '```').at(-1);
  const normalized = lastLine?.replace(/^(?:\*\*|__)(.+)(?:\*\*|__)$/, '$1');
  if (!isOutcome(normalized)) return { outcome: output.trim().length === 0 ? 'FAILED' : 'BLOCKED', displayBody: output.trim() };
  let removed = false;
  return {
    outcome: normalized,
    displayBody: lines.reverse().filter((line) => {
      if (!removed && line.trim() === lastLine) { removed = true; return false; }
      return true;
    }).reverse().join('\n').trim(),
  };
}

function parseEnvelope(value: string): AgentRunOutcome | undefined {
  try { const parsed = JSON.parse(value.trim()) as { status?: unknown }; return isOutcome(parsed.status) ? parsed.status : undefined; } catch { return undefined; }
}

function isOutcome(value: unknown): value is AgentRunOutcome {
  return value === 'DONE' || value === 'REJECTED' || value === 'BLOCKED' || value === 'FAILED';
}

function synthesized(outcome: AgentRunOutcome): string {
  return { DONE: 'Run completed.', REJECTED: 'Run rejected - needs changes.', BLOCKED: 'Run blocked - needs input.', FAILED: 'Run failed.' }[outcome];
}

function metadata(result: AgentRunnerResult): Readonly<Record<string, string | number | boolean | null>> {
  return {
    runner: result.runner,
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    ...(result.tokenUsage === undefined ? {} : {
      inputTokens: result.tokenUsage.input,
      outputTokens: result.tokenUsage.output,
      ...(result.tokenUsage.cacheRead === undefined ? {} : { cacheReadTokens: result.tokenUsage.cacheRead }),
      ...(result.tokenUsage.cacheWrite === undefined ? {} : { cacheWriteTokens: result.tokenUsage.cacheWrite }),
      ...(result.tokenUsage.costUsd === undefined ? {} : { costUsd: result.tokenUsage.costUsd }),
    }),
  };
}