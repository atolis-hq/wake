// Presentation-only formatting for run summaries (cost, duration, tokens).
// Pure functions with no dependency on tick state — kept in lib/ so they are
// directly unit-testable rather than only reachable through a full run.

// The subset of an agent run's token usage that contributes to the reported
// total. Declared structurally (rather than importing AgentRunTokenUsage from
// core/contracts.ts) so lib/ stays free of any dependency on core/.
export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export function extractTokenCount(tokenUsage: TokenUsageBreakdown | undefined): number | undefined {
  if (tokenUsage === undefined) {
    return undefined;
  }
  // Cache tokens dominate real usage and were previously dropped from this
  // total entirely, understating the reported figure by roughly an order of
  // magnitude (#135).
  return (
    tokenUsage.inputTokens +
    tokenUsage.outputTokens +
    (tokenUsage.cacheCreationInputTokens ?? 0) +
    (tokenUsage.cacheReadInputTokens ?? 0)
  );
}

export function formatCostUsd(costUsd: number): string {
  return `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
}

export function formatDuration(startedAtStr: string, finishedAtStr: string): string | undefined {
  const startedAt = new Date(startedAtStr);
  const finishedAt = new Date(finishedAtStr);
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  if (durationMs < 0 || !isFinite(durationMs)) return undefined;

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(0)}k`;
  }
  return String(count);
}
