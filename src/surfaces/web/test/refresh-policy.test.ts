import { describe, expect, it } from 'vitest';
import { refreshInterval, refreshPolicy } from '../src/api/refresh-policy.js';

describe('independent operational refresh policy', () => {
  it('uses the approved intervals and leaves analytical views explicit-only', () => {
    expect(refreshPolicy).toEqual({
      status: 2_000,
      board: 3_000,
      openWork: 3_000,
      activeRuns: 3_000,
      events: 3_000,
      historicalRuns: 5_000,
      health: 5_000,
      runners: 5_000,
      observability: false,
      configuration: false,
      commands: false,
      workflowDiagrams: 3_000,
    });
    expect(refreshInterval.runs([{ active: true }])).toBe(3_000);
    expect(refreshInterval.runs([{ active: false }])).toBe(5_000);
  });
});
