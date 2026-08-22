import { describe, expect, it } from 'vitest';
import {
  gitHubConfigSchema,
  selectReplyTarget,
} from '../../../../src/integrations/github/index.js';

const baseConfig = {
  enabled: true,
  repositories: [{ owner: 'acme', repo: 'widgets' }],
};

describe('GitHub reply routing configuration', () => {
  it('normalizes single and array facet values and maps outcomes to runtime values', () => {
    const config = gitHubConfigSchema.parse({
      ...baseConfig,
      publication: {
        replies: {
          rules: [
            {
              match: { stage: 'review', outcome: ['blocked', 'needs-clarification'] },
              matchMode: 'all',
              target: 'pull-request',
            },
          ],
          default: 'none',
        },
      },
    });

    expect(config.publication.replies).toEqual({
      rules: [
        {
          match: { stage: ['review'], outcome: ['BLOCKED', 'NEEDS_CLARIFICATION'] },
          matchMode: 'all',
          target: 'pull-request',
        },
      ],
      default: 'none',
    });
  });

  it('requires an explicit target and rejects invalid config-facing outcome values', () => {
    expect(() =>
      gitHubConfigSchema.parse({
        ...baseConfig,
        publication: { replies: { rules: [{ match: { stage: 'review' } }] } },
      }),
    ).toThrow();
    expect(() =>
      gitHubConfigSchema.parse({
        ...baseConfig,
        publication: {
          replies: { rules: [{ match: { outcome: 'BLOCKED' }, target: 'primary' }] },
        },
      }),
    ).toThrow();
  });
});

describe('selectReplyTarget', () => {
  const routing = gitHubConfigSchema.parse({
    ...baseConfig,
    publication: {
      replies: {
        rules: [
          { match: { stage: 'review' }, target: 'issue' },
          {
            match: { stage: 'review', outcome: 'blocked' },
            matchMode: 'all',
            target: 'pull-request',
          },
        ],
        default: 'none',
      },
    },
  }).publication.replies;

  it('uses the first matching rule', () => {
    expect(
      selectReplyTarget({ stage: 'review', outcome: 'BLOCKED' }, routing.rules, routing.default),
    ).toBe('issue');
  });

  it('combines stage and outcome under all mode', () => {
    const rule = routing.rules[1]!;
    expect(selectReplyTarget({ stage: 'review', outcome: 'BLOCKED' }, [rule], 'primary')).toBe(
      'pull-request',
    );
    expect(selectReplyTarget({ stage: 'review', outcome: 'DONE' }, [rule], 'primary')).toBe(
      'primary',
    );
  });

  it('uses the configured default when nothing matches', () => {
    expect(
      selectReplyTarget({ stage: 'implement', outcome: 'DONE' }, routing.rules, routing.default),
    ).toBe('none');
  });
});
