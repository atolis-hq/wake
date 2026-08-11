import { describe, expect, it } from 'vitest';
import { fmtDuration } from '../src/components/format.js';

describe('fmtDuration', () => {
  it('shows exact seconds under 10s', () => {
    expect(fmtDuration(1)).toBe('1s');
    expect(fmtDuration(999)).toBe('1s');
    expect(fmtDuration(1_000)).toBe('1s');
    expect(fmtDuration(7_000)).toBe('7s');
    expect(fmtDuration(9_999)).toBe('9s');
  });

  it('rounds down to the nearest 10s between 10s and 59s', () => {
    expect(fmtDuration(10_000)).toBe('10s');
    expect(fmtDuration(14_999)).toBe('10s');
    expect(fmtDuration(40_000)).toBe('40s');
    expect(fmtDuration(59_999)).toBe('50s');
  });

  it('shows floor minutes between 1m and 59m', () => {
    expect(fmtDuration(60_000)).toBe('1m');
    expect(fmtDuration(12 * 60_000 + 45_000)).toBe('12m');
    expect(fmtDuration(59 * 60_000 + 59_000)).toBe('59m');
  });

  it('shows hours and minutes between 1h and 24h', () => {
    expect(fmtDuration(60 * 60_000)).toBe('1h0m');
    expect(fmtDuration(60 * 60_000 + 5 * 60_000)).toBe('1h5m');
    expect(fmtDuration(23 * 60 * 60_000 + 59 * 60_000)).toBe('23h59m');
  });

  it('shows floor days at 24h and beyond', () => {
    expect(fmtDuration(24 * 60 * 60_000)).toBe('1d');
    expect(fmtDuration(2 * 24 * 60 * 60_000 + 5 * 60 * 60_000)).toBe('2d');
  });

  it('returns an empty string for non-finite or negative input', () => {
    expect(fmtDuration(-1)).toBe('');
    expect(fmtDuration(Number.NaN)).toBe('');
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe('');
  });
});
