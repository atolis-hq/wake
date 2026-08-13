import { describe, expect, it } from 'vitest';
import { parseFakeScenarios } from '../../../src/execution/index.js';

describe('fake scenarios', () => {
  it('uses the first matching runner, action, and occurrence rule', () => {
    const scenarios = parseFakeScenarios({
      schemaVersion: 1,
      rules: [
        {
          name: 'first-match',
          when: {
            runner: 'fake-worker',
            action: 'refine',
            occurrence: 1,
          },
          afterMs: 7000,
          outcome: 'FAILED',
          retrySafety: 'safe-to-retry',
        },
        {
          name: 'later-match',
          when: {
            runner: 'fake-worker',
            action: 'refine',
            occurrence: 1,
          },
          afterMs: 1,
          outcome: 'DONE',
        },
      ],
    });

    expect(
      scenarios.resolve({
        runner: 'fake-worker',
        action: 'refine',
        occurrence: 1,
      }),
    ).toMatchObject({ name: 'first-match', outcome: 'FAILED', delayMs: 7000 });
  });

  it('returns the same seeded random delay for the same invocation', () => {
    const scenarios = parseFakeScenarios({
      schemaVersion: 1,
      rules: [
        {
          name: 'seeded',
          when: { runner: 'fake-worker', action: 'implement' },
          afterMs: { min: 1000, max: 10000, seed: 42 },
          outcome: 'DONE',
        },
      ],
    });
    const match = { runner: 'fake-worker', action: 'implement', occurrence: 1 };

    expect(scenarios.resolve(match)?.delayMs).toBe(scenarios.resolve(match)?.delayMs);
  });

  it('rejects invalid delay ranges and retry safety for non-failures', () => {
    expect(() =>
      parseFakeScenarios({
        schemaVersion: 1,
        rules: [
          {
            name: 'bad-range',
            when: { runner: 'fake', action: 'refine' },
            afterMs: { min: 10, max: 1, seed: 1 },
            outcome: 'DONE',
          },
        ],
      }),
    ).toThrow(/min/i);

    expect(() =>
      parseFakeScenarios({
        schemaVersion: 1,
        rules: [
          {
            name: 'bad-retry-safety',
            when: { runner: 'fake', action: 'refine' },
            afterMs: 1,
            outcome: 'DONE',
            retrySafety: 'safe-to-retry',
          },
        ],
      }),
    ).toThrow(/retrySafety/i);
  });
});
