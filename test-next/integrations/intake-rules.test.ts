import { describe, expect, it } from 'vitest';
import { MatchMode } from '../../src-next/kernel/index.js';
import { evaluateIntakeRules } from '../../src-next/integrations/index.js';
import {
  GitHubWakeMarkerPrefix,
  gitHubConfigSchema,
} from '../../src-next/integrations/github/index.js';

const IntakeFacet = { Kind: 'kind', Label: 'label' } as const;

describe('evaluateIntakeRules', () => {
  it('assigns configured tags to a matching observation', () => {
    const decision = evaluateIntakeRules(
      [
        {
          where: { [IntakeFacet.Label]: ['bug'] },
          matchMode: MatchMode.Any,
          tags: ['bug'],
        },
        {
          where: { [IntakeFacet.Kind]: ['pull-request'] },
          matchMode: MatchMode.Any,
          tags: ['review'],
        },
      ],
      { [IntakeFacet.Kind]: ['pull-request'], [IntakeFacet.Label]: ['bug'] },
    );

    expect(decision).toEqual({ admitted: true, tags: ['bug', 'review'] });
  });

  it('produces no observation for an item matching no eligibility rule', () => {
    const decision = evaluateIntakeRules(
      [{ where: { [IntakeFacet.Label]: ['bug'] }, matchMode: MatchMode.Any, tags: ['bug'] }],
      { [IntakeFacet.Kind]: ['issue'], [IntakeFacet.Label]: ['chore'] },
    );

    expect(decision).toEqual({ admitted: false, tags: [] });
  });

  it('admits everything with no tags when no rule is configured', () => {
    expect(evaluateIntakeRules([], { [IntakeFacet.Kind]: ['issue'] })).toEqual({
      admitted: true,
      tags: [],
    });
  });

  it('requires every facet value under all mode and AND-s separate facets', () => {
    const rules = [
      {
        where: { [IntakeFacet.Kind]: ['issue'], [IntakeFacet.Label]: ['bug', 'urgent'] },
        matchMode: MatchMode.All,
        tags: ['triage'],
      },
    ];

    expect(
      evaluateIntakeRules(rules, {
        [IntakeFacet.Kind]: ['issue'],
        [IntakeFacet.Label]: ['bug'],
      }).admitted,
    ).toBe(false);
    expect(
      evaluateIntakeRules(rules, {
        [IntakeFacet.Kind]: ['issue'],
        [IntakeFacet.Label]: ['urgent', 'bug'],
      }).admitted,
    ).toBe(true);
    expect(
      evaluateIntakeRules(rules, {
        [IntakeFacet.Kind]: ['pull-request'],
        [IntakeFacet.Label]: ['urgent', 'bug'],
      }).admitted,
    ).toBe(false);
  });
});

describe('GitHub intake configuration', () => {
  // Every family Wake republishes must be refused, or the adapter observes Wake's own
  // marker, the tag set changes, the selector re-routes, and Wake publishes again.
  it.each(Object.values(GitHubWakeMarkerPrefix))(
    'rejects an intake rule that tags from the %s marker family',
    (prefix) => {
      expect(() =>
        gitHubConfigSchema.parse({
          enabled: true,
          token: 'token',
          repositories: [{ owner: 'acme', repo: 'widgets' }],
          intake: [{ where: { labels: ['bug'] }, tags: [`${prefix}working`] }],
        }),
      ).toThrow(/wake-owned/i);
    },
  );

  it('accepts an intake rule tagging outside every Wake-owned marker family', () => {
    const config = gitHubConfigSchema.parse({
      enabled: true,
      token: 'token',
      repositories: [{ owner: 'acme', repo: 'widgets' }],
      intake: [{ where: { labels: ['bug'] }, tags: ['bug'] }],
    });

    expect(config.intake[0]?.tags).toEqual(['bug']);
  });
});
