import { describe, expect, it } from 'vitest';
import { refreshInterval, refreshPolicy } from '../src/api/refresh-policy.js';

describe('independent operational refresh policy', () => {
  it('refreshes API-presented active runs and leaves analytical views explicit-only', () => {
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
    // The API presents Starting runs as active; this policy intentionally consumes only that flag.
    expect(refreshInterval.runs([{ active: true }])).toBe(3_000);
    expect(refreshInterval.runs([{ active: false }])).toBe(5_000);
  });
});
