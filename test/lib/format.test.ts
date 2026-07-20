import { describe, expect, it } from 'vitest';

import {
  extractTokenCount,
  formatCostUsd,
  formatDuration,
  formatTokenCount,
} from '../../src/lib/format.js';

describe('extractTokenCount', () => {
  it('returns undefined when no usage is present', () => {
    expect(extractTokenCount(undefined)).toBeUndefined();
  });

  it('sums input and output tokens', () => {
    expect(extractTokenCount({ inputTokens: 100, outputTokens: 50 })).toBe(150);
  });

  it('includes cache tokens, which dominate real usage (#135)', () => {
    expect(
      extractTokenCount({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 2000,
        cacheReadInputTokens: 8000,
      }),
    ).toBe(10150);
  });
});

describe('formatCostUsd', () => {
  it('uses four decimals below one dollar', () => {
    expect(formatCostUsd(0.1234)).toBe('$0.1234');
  });

  it('uses two decimals at or above one dollar', () => {
    expect(formatCostUsd(12.3456)).toBe('$12.35');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration('2026-07-05T12:00:00.000Z', '2026-07-05T12:00:42.000Z')).toBe('42s');
  });

  it('formats multi-minute durations as minutes and seconds', () => {
    expect(formatDuration('2026-07-05T12:00:00.000Z', '2026-07-05T12:03:07.000Z')).toBe('3m7s');
  });

  it('returns undefined for a negative duration', () => {
    expect(formatDuration('2026-07-05T12:03:00.000Z', '2026-07-05T12:00:00.000Z')).toBeUndefined();
  });

  it('returns undefined for an unparseable timestamp', () => {
    expect(formatDuration('not-a-date', '2026-07-05T12:00:00.000Z')).toBeUndefined();
  });
});

describe('formatTokenCount', () => {
  it('renders raw counts below a thousand', () => {
    expect(formatTokenCount(742)).toBe('742');
  });

  it('renders thousands with a k suffix and no decimals', () => {
    expect(formatTokenCount(12500)).toBe('13k');
  });

  it('renders millions with one decimal', () => {
    expect(formatTokenCount(2_400_000)).toBe('2.4M');
  });
});
