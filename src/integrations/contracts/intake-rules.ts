import { matchesRequiredValues, type MatchMode } from '../../kernel/index.js';

// Facet names are provider vocabulary. This module only does set arithmetic over them,
// so eligibility and tagging semantics stay identical across providers.
export type IntakeFacts = Readonly<Record<string, readonly string[]>>;

export interface IntakeRule {
  readonly where: IntakeFacts;
  /** Values which explicitly suppress this rule's observation. */
  readonly ignoredValues?: IntakeFacts | undefined;
  readonly matchMode: MatchMode;
  readonly tags: readonly string[];
}

export interface IntakeDecision {
  readonly admitted: boolean;
  readonly tags: readonly string[];
  readonly ignored?: true | undefined;
}

// With no rules configured every observation is admitted and carries no tags; otherwise an
// observation must match at least one rule, and collects the tags of every rule it matches.
export function evaluateIntakeRules(
  rules: readonly IntakeRule[],
  facts: IntakeFacts,
): IntakeDecision {
  if (rules.length === 0) return { admitted: true, tags: [] };
  if (rules.some((rule) => isIgnored(rule, facts)))
    return { admitted: false, tags: [], ignored: true };
  const matched = rules.filter((rule) => ruleMatches(rule, facts));
  if (matched.length === 0) return { admitted: false, tags: [] };
  return { admitted: true, tags: [...new Set(matched.flatMap((rule) => rule.tags))] };
}

function isIgnored(rule: IntakeRule, facts: IntakeFacts): boolean {
  return Object.entries(rule.ignoredValues ?? {}).some(([facet, values]) =>
    values.some((value) => (facts[facet] ?? []).includes(value)),
  );
}

function ruleMatches(rule: IntakeRule, facts: IntakeFacts): boolean {
  return Object.entries(rule.where).every(([facet, required]) =>
    matchesRequiredValues(rule.matchMode, required, facts[facet] ?? []),
  );
}
