import { describe, expect, it } from 'vitest';
import { gitHubIssueQueryFilters } from '../../../../src/integrations/github/application/intake-policy.js';
import { gitHubConfigSchema } from '../../../../src/integrations/github/contracts/config.js';

function intake(
  rules: readonly {
    readonly requiredAssignees?: readonly string[];
    readonly labels?: readonly string[];
  }[],
) {
  return gitHubConfigSchema.parse({
    enabled: true,
    repositories: [{ owner: 'owner', repo: 'repo' }],
    intake: rules.map((rule) => ({
      where: {
        requiredAssignees: rule.requiredAssignees ?? [],
        labels: rule.labels ?? [],
      },
    })),
  }).intake;
}

describe('gitHubIssueQueryFilters', () => {
  it('uses each facet independently when every rule requires its same single value', () => {
    expect(
      gitHubIssueQueryFilters(
        intake([
          { requiredAssignees: ['wake-bot'], labels: ['wake'] },
          { requiredAssignees: ['wake-bot'], labels: ['wake'] },
        ]),
      ),
    ).toEqual({ assignee: 'wake-bot', labels: 'wake' });
  });

  it('keeps an unambiguous facet when the other facet is not lossless', () => {
    expect(
      gitHubIssueQueryFilters(
        intake([
          { requiredAssignees: ['wake-bot'], labels: ['one'] },
          { requiredAssignees: ['wake-bot'], labels: ['two'] },
        ]),
      ),
    ).toEqual({ assignee: 'wake-bot' });
  });

  it('treats duplicate required values as one distinct query filter value', () => {
    expect(
      gitHubIssueQueryFilters(
        intake([
          { requiredAssignees: ['wake-bot', 'wake-bot'], labels: ['wake', 'wake'] },
          { requiredAssignees: ['wake-bot'], labels: ['wake'] },
        ]),
      ),
    ).toEqual({ assignee: 'wake-bot', labels: 'wake' });
  });

  it.each([
    ['no intake rules', [], {}],
    ['a rule without an assignee', [{ requiredAssignees: ['wake-bot'] }, {}], {}],
    ['multiple assignees', [{ requiredAssignees: ['one', 'two'] }], {}],
    ['a rule without a label', [{ labels: ['wake'] }, {}], {}],
    ['multiple labels', [{ labels: ['one', 'two'] }], {}],
  ])('omits filters for %s', (_description, rules, expected) => {
    expect(gitHubIssueQueryFilters(intake(rules))).toEqual(expected);
  });
});
