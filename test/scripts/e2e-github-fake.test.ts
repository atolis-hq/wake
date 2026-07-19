import { describe, expect, it } from 'vitest';

import {
  buildE2eConfig,
  parseIssueNumberFromUrl,
  validateTickOutcome,
  waitForProcessedTick,
} from '../../scripts/e2e-github-fake.js';

describe('e2e github fake helpers', () => {
  it('builds a github-enabled config for a required label', () => {
    const config = buildE2eConfig({
      wakeRoot: 'C:/tmp/wake-e2e',
      repo: 'atolis-hq/wake',
      requiredLabel: 'wake:e2e',
    });

    expect(config.sources.github.enabled).toBe(true);
    expect(config.sources.github.repos).toEqual(['atolis-hq/wake']);
    expect(config.sources.github.policy.requiredLabels).toEqual(['wake:e2e']);
  });

  it('parses the issue number from a github issue url', () => {
    expect(parseIssueNumberFromUrl('https://github.com/atolis-hq/wake/issues/123')).toBe(123);
  });

  it('rejects a non-processed second tick outcome', () => {
    expect(() =>
      validateTickOutcome(
        { status: 'idle' },
        { expectedStatus: 'processed', expectedSentinel: 'DONE' },
      ),
    ).toThrow(/Expected tick status processed/i);
  });

  it('retries ticks until a processed outcome is returned', async () => {
    let attempts = 0;

    const outcome = await waitForProcessedTick({
      maxAttempts: 3,
      delayMs: 0,
      runTick: async () => {
        attempts += 1;
        return attempts < 3 ? { status: 'idle' } : { status: 'processed', sentinel: 'DONE' };
      },
    });

    expect(outcome).toEqual({ status: 'processed', sentinel: 'DONE' });
    expect(attempts).toBe(3);
  });
});
