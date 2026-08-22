import type { MatchMode } from '../../kernel/index.js';

export const ReplyTarget = {
  Primary: 'primary',
  Issue: 'issue',
  PullRequest: 'pull-request',
  None: 'none',
} as const;
export type ReplyTarget = (typeof ReplyTarget)[keyof typeof ReplyTarget];

export const ReplyOutcome = {
  Done: 'DONE',
  Rejected: 'REJECTED',
  Blocked: 'BLOCKED',
  Failed: 'FAILED',
  NeedsClarification: 'NEEDS_CLARIFICATION',
} as const;
export type ReplyOutcome = (typeof ReplyOutcome)[keyof typeof ReplyOutcome];

export const ReplyOutcomeConfig = {
  Done: 'done',
  Rejected: 'rejected',
  Blocked: 'blocked',
  Failed: 'failed',
  NeedsClarification: 'needs-clarification',
} as const;

export interface ReplyRoutingRule {
  readonly match: { readonly stage?: readonly string[]; readonly outcome?: readonly ReplyOutcome[] };
  readonly matchMode: MatchMode;
  readonly target: ReplyTarget;
}

export interface ReplyPublicationConfig {
  readonly rules: readonly ReplyRoutingRule[];
  readonly default: ReplyTarget;
}
