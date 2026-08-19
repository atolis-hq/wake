import type { IntakeFacts, IntakeRule } from '../../contracts/intake-rules.js';
import type { GitHubIntakeRuleConfig } from '../contracts/config.js';
import type { ExternalWorkObservedPayload } from '../contracts/events.js';
import type { GitHubIssueQueryFilters } from '../contracts/issue-query.js';
import { GitHubIntakeFacet } from '../contracts/vocabulary.js';

// GitHub's `where` vocabulary translated onto provider-neutral facets. Eligibility and
// tagging semantics live in integrations/contracts; only the vocabulary is GitHub's.
export function gitHubIntakeRules(
  configured: readonly GitHubIntakeRuleConfig[],
): readonly IntakeRule[] {
  return configured.map((rule) => ({
    where: {
      ...(rule.where.kind === undefined ? {} : { [GitHubIntakeFacet.Kind]: [rule.where.kind] }),
      [GitHubIntakeFacet.Label]: rule.where.labels,
      [GitHubIntakeFacet.Assignee]: rule.where.requiredAssignees,
      [GitHubIntakeFacet.Author]: rule.where.requiredAuthors,
    },
    ignoredValues: { [GitHubIntakeFacet.Label]: rule.ignoredLabels },
    matchMode: rule.matchMode,
    tags: rule.tags,
  }));
}

// Rules are OR-composed. A native facet filter is safe only when every rule
// requires the same single value; otherwise it could hide an item another rule admits.
export function gitHubIssueQueryFilters(
  configured: readonly GitHubIntakeRuleConfig[],
): GitHubIssueQueryFilters {
  const assignee = sharedRequiredValue(configured, (rule) => rule.where.requiredAssignees);
  const labels = sharedRequiredValue(configured, (rule) => rule.where.labels);
  return {
    ...(assignee === undefined ? {} : { assignee }),
    ...(labels === undefined ? {} : { labels }),
  };
}

function sharedRequiredValue(
  configured: readonly GitHubIntakeRuleConfig[],
  values: (rule: GitHubIntakeRuleConfig) => readonly string[],
): string | undefined {
  if (configured.length === 0) return undefined;
  const candidate = values(configured[0]!);
  if (candidate.length !== 1) return undefined;
  return configured.every((rule) => {
    const required = values(rule);
    return required.length === 1 && required[0] === candidate[0];
  })
    ? candidate[0]
    : undefined;
}

export function gitHubIntakeFacts(payload: ExternalWorkObservedPayload): IntakeFacts {
  return {
    [GitHubIntakeFacet.Kind]: [payload.kind],
    [GitHubIntakeFacet.Label]: payload.labels ?? [],
    [GitHubIntakeFacet.Assignee]: payload.assignees ?? [],
    [GitHubIntakeFacet.Author]: [payload.actor.id],
  };
}
