import { describe, expect, it } from 'vitest';

import { deepMergeRaw } from '../../src/lib/deep-merge.js';

describe('deepMergeRaw', () => {
  it('merges disjoint top-level keys from both objects', () => {
    const result = deepMergeRaw(
      { sandbox: { image: 'a' } },
      { runners: { fake: { kind: 'fake' } } },
    );

    expect(result).toEqual({ sandbox: { image: 'a' }, runners: { fake: { kind: 'fake' } } });
  });

  it('recursively merges nested objects instead of replacing the whole subtree', () => {
    const result = deepMergeRaw(
      { sources: { github: { enabled: true } } },
      { sources: { github: { repos: ['org/repo'] } } },
    );

    expect(result).toEqual({ sources: { github: { enabled: true, repos: ['org/repo'] } } });
  });

  it('lets the source value win on a direct key conflict', () => {
    const result = deepMergeRaw({ defaultTier: 'standard' }, { defaultTier: 'deep' });

    expect(result.defaultTier).toBe('deep');
  });

  it('replaces arrays wholesale rather than concatenating them', () => {
    const result = deepMergeRaw(
      { sources: { github: { repos: ['a'] } } },
      { sources: { github: { repos: ['b'] } } },
    );

    expect(result.sources).toEqual({ github: { repos: ['b'] } });
  });

  it('does not mutate either input', () => {
    const target = { sandbox: { image: 'a' } };
    const source = { sandbox: { containerName: 'b' } };

    deepMergeRaw(target, source);

    expect(target).toEqual({ sandbox: { image: 'a' } });
    expect(source).toEqual({ sandbox: { containerName: 'b' } });
  });
});
