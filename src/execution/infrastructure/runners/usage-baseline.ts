import type { AgentRunnerResult, RunnerRequest } from '../../contracts/runner.js';

export interface CumulativeUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

// Vendors that report a cumulative snapshot on resumed sessions need the prior
// per-invocation totals subtracted; an unsafe subtraction reports no usage.
export function usageSinceBaseline(
  usage: CumulativeUsage | undefined,
  baseline: RunnerRequest['usageBaseline'],
): AgentRunnerResult['tokenUsage'] | undefined {
  if (usage === undefined) return undefined;
  if (baseline === undefined) return nonNegativeUsage(usage);
  if (!nonNegativeUsage(baseline)) return undefined;
  const input = subtract(usage.input, baseline.input);
  const output = subtract(usage.output, baseline.output);
  const cacheRead = cacheDelta(usage.cacheRead, baseline.cacheRead);
  const cacheWrite = cacheDelta(usage.cacheWrite, baseline.cacheWrite);
  if (
    !isRequiredDelta(input) ||
    !isRequiredDelta(output) ||
    !isOptionalDelta(cacheRead) ||
    !isOptionalDelta(cacheWrite)
  ) {
    return undefined;
  }
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function nonNegativeUsage(usage: CumulativeUsage): CumulativeUsage | undefined {
  return Object.values(usage).every((value) => Number.isFinite(value) && value >= 0)
    ? usage
    : undefined;
}

function isRequiredDelta(value: number | undefined): value is number {
  return typeof value === 'number';
}

function isOptionalDelta(value: number | 'inconsistent' | undefined): value is number | undefined {
  return value === undefined || typeof value === 'number';
}

function subtract(total: number, baseline: number): number | undefined {
  const delta = total - baseline;
  return Number.isFinite(delta) && delta >= 0 ? delta : undefined;
}

function cacheDelta(
  total: number | undefined,
  baseline: number | undefined,
): number | 'inconsistent' | undefined {
  if (total === undefined) return baseline === undefined ? undefined : 'inconsistent';
  return subtract(total, baseline ?? 0);
}
