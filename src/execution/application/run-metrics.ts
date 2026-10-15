import type { BreakdownReport } from '../../kernel/index.js';
import { agentTokenUsage } from '../contracts/runner.js';
import type { RunView } from '../contracts/views.js';
import { runDuration } from './run-duration.js';

export function runBreakdownMetrics(
  run: RunView,
): Omit<BreakdownReport['dimensions'][number]['rows'][number], 'value' | 'share'> {
  const usage = agentTokenUsage(run.agent?.metadata);
  const metadata = run.agent?.metadata;
  const hasFinite = (key: string) =>
    typeof metadata?.[key] === 'number' && Number.isFinite(metadata[key]);
  const duration = runDuration(run);
  return {
    count: 1,
    tokens: finiteOrZero(usage.tokens),
    costUsd: finiteOrZero(usage.costUsd),
    durationMs: duration ?? 0,
    tokenRuns: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(
      hasFinite,
    )
      ? 1
      : 0,
    costRuns: hasFinite('costUsd') ? 1 : 0,
    durationRuns: duration === null ? 0 : 1,
  };
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
