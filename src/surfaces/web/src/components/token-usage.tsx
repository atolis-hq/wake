import { fmtCompact } from './format.js';

interface TokenUsageValue {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export function TokenUsage({ usage }: { readonly usage: TokenUsageValue }) {
  const detail = [
    usage.inputTokens === undefined ? undefined : `Input ${fmtCompact(usage.inputTokens)}`,
    usage.outputTokens === undefined ? undefined : `Output ${fmtCompact(usage.outputTokens)}`,
    usage.cacheReadTokens === undefined
      ? undefined
      : `Cache read ${fmtCompact(usage.cacheReadTokens)}`,
    usage.cacheWriteTokens === undefined
      ? undefined
      : `Cache write ${fmtCompact(usage.cacheWriteTokens)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  return <abbr title={detail === '' ? undefined : detail}>{fmtCompact(usage.totalTokens)}</abbr>;
}
