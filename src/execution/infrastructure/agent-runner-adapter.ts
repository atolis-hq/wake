import {
  AgentResultStatus,
  ClaudeAuthenticationFailureKind,
  parseAgentStatusMarker,
  translateAgentResult,
} from '../../activities/index.js';
import type { AgentRunOutcome, AgentRunResponse, AgentRunnerResult } from '../contracts/runner.js';
import { RunStatus } from '../contracts/vocabulary.js';

export function parseAgentRunnerResponse(result: AgentRunnerResult): AgentRunResponse {
  const parsed = parseResult(result.output);
  const outcome =
    result.transport === RunStatus.Succeeded && result.unverifiedCompletionReason !== undefined
      ? AgentResultStatus.Blocked
      : result.transport === RunStatus.Succeeded
        ? parsed.outcome
        : result.failure?.kind === ClaudeAuthenticationFailureKind
          ? AgentResultStatus.Blocked
          : AgentResultStatus.Failed;
  return {
    outcome,
    displayBody:
      result.transport === RunStatus.Succeeded && result.unverifiedCompletionReason === undefined
        ? parsed.displayBody
        : result.unverifiedCompletionReason !== undefined
          ? result.unverifiedCompletionReason
          : result.failure?.message || parsed.displayBody || 'Runner failed without a response.',
    metadata: metadata(result),
  };
}

function parseResult(output: string): {
  readonly outcome: AgentRunOutcome;
  readonly displayBody: string;
} {
  const translated = translateAgentResult(output);
  const status = 'status' in translated.data ? translated.data.status : AgentResultStatus.Failed;
  const marker = parseAgentStatusMarker(output);
  if (!('status' in translated.data))
    return { outcome: status, displayBody: marker?.displayBody ?? output.trim() };
  try {
    const value = JSON.parse(output) as { readonly displayBody?: unknown };
    return {
      outcome: status,
      displayBody:
        typeof value?.displayBody === 'string' && value.displayBody.trim().length > 0
          ? value.displayBody
          : synthesized(status),
    };
  } catch {
    return { outcome: status, displayBody: marker?.displayBody ?? output.trim() };
  }
}

function synthesized(outcome: AgentRunOutcome): string {
  return {
    DONE: 'Run completed.',
    REJECTED: 'Run rejected - needs changes.',
    BLOCKED: 'Run blocked - needs input.',
    FAILED: 'Run failed.',
    NEEDS_CLARIFICATION: 'Run needs clarification.',
  }[outcome];
}

function metadata(
  result: AgentRunnerResult,
): Readonly<Record<string, string | number | boolean | null>> {
  return {
    runner: result.runner,
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    ...(result.tokenUsage === undefined
      ? {}
      : {
          inputTokens: result.tokenUsage.input,
          outputTokens: result.tokenUsage.output,
          ...(result.tokenUsage.cacheRead === undefined
            ? {}
            : { cacheReadTokens: result.tokenUsage.cacheRead }),
          ...(result.tokenUsage.cacheWrite === undefined
            ? {}
            : { cacheWriteTokens: result.tokenUsage.cacheWrite }),
          ...(result.tokenUsage.costUsd === undefined
            ? {}
            : { costUsd: result.tokenUsage.costUsd }),
        }),
  };
}
