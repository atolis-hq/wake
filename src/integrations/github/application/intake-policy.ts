import type { IntakeFacts, IntakeRule } from '../../contracts/intake-rules.js';
import type { GitHubIntakeRuleConfig } from '../contracts/config.js';
import type { ExternalWorkObservedPayload } from '../contracts/events.js';
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
    matchMode: rule.matchMode,
    tags: rule.tags,
  }));
}

export function gitHubIntakeFacts(payload: ExternalWorkObservedPayload): IntakeFacts {
  return {
    [GitHubIntakeFacet.Kind]: [payload.kind],
    [GitHubIntakeFacet.Label]: payload.labels ?? [],
    [GitHubIntakeFacet.Assignee]: payload.assignees ?? [],
    [GitHubIntakeFacet.Author]: [payload.actor.id],
  };
}
