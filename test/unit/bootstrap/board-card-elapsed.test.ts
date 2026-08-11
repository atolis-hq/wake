import { describe, expect, it } from 'vitest';
import { elapsedSince } from '../../../src/bootstrap/surface-api-applications.js';

describe('elapsedSince', () => {
  it.each([
    ['five-minute gap', '2026-08-03T12:00:00.000Z', '2026-08-03T12:05:00.000Z', 300_000],
    ['two-minute gap', '2026-08-03T12:00:00.000Z', '2026-08-03T12:02:00.000Z', 120_000],
    ['zero gap', '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z', 0],
  ])('returns the elapsed time for %s', (_label, timestamp, now, expected) => {
    expect(elapsedSince(timestamp, Date.parse(now))).toBe(expected);
  });
});
