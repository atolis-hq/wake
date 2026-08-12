import { describe, expect, it } from 'vitest';

import { agentTokenUsage } from '../../../src/execution/contracts/runner.js';

describe('agentTokenUsage', () => {
  it('excludes cache token subsets from the aggregate token count', () => {
    expect(
      agentTokenUsage({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 80,
        cacheWriteTokens: 5,
      }),
    ).toEqual({ tokens: 110, costUsd: 0 });
  });

  it('handles metadata without cache token fields', () => {
    expect(agentTokenUsage({ inputTokens: 100, outputTokens: 10 })).toEqual({
      tokens: 110,
      costUsd: 0,
    });
  });
});
