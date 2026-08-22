import { matchesRequiredValues } from '../../../kernel/index.js';
import { ReplyTarget, type ReplyOutcome, type ReplyPublicationConfig, type ReplyRoutingRule } from '../../contracts/reply-routing.js';

export interface ReplyTargetCandidate {
  readonly stage?: string | undefined;
  readonly outcome: ReplyOutcome;
}

/** Selects one configured reply target; the first matching rule wins. */
export function selectReplyTarget(
  candidate: ReplyTargetCandidate,
  rules: readonly ReplyRoutingRule[],
  fallback: ReplyPublicationConfig['default'],
): ReplyPublicationConfig['default'] {
  return rules.find((rule) => ruleMatches(rule, candidate))?.target ?? fallback;
}

function ruleMatches(rule: ReplyRoutingRule, candidate: ReplyTargetCandidate): boolean {
  return (
    matchesRequiredValues(rule.matchMode, rule.match.stage ?? [], singleton(candidate.stage)) &&
    matchesRequiredValues(rule.matchMode, rule.match.outcome ?? [], [candidate.outcome])
  );
}

function singleton(value: string | undefined): readonly string[] {
  return value === undefined ? [] : [value];
}

export const defaultReplyPublication: ReplyPublicationConfig = {
  rules: [],
  default: ReplyTarget.Primary,
};
