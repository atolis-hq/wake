import { ActivityOutcomeKind, ProviderPermission } from '../../activities/index.js';
import type { AgentRunOutcome } from '../../execution/index.js';
import type { MatchMode, ValueOf } from '../../kernel/index.js';
import { BuiltInResourceKind, ResourceCorrelationRole } from '../../resources/index.js';

export const ReplyTarget = {
  Primary: ResourceCorrelationRole.Primary,
  Issue: BuiltInResourceKind.Issue,
  PullRequest: BuiltInResourceKind.PullRequest,
  None: ProviderPermission.None,
} as const;
export type ReplyTarget = ValueOf<typeof ReplyTarget>;

export type ReplyOutcome = AgentRunOutcome;

export const ReplyNeedsClarificationConfig = 'needs-clarification' as const;

export const ReplyOutcomeConfig = {
  Done: ActivityOutcomeKind.Done,
  Rejected: ActivityOutcomeKind.Rejected,
  Blocked: ActivityOutcomeKind.Blocked,
  Failed: ActivityOutcomeKind.Failed,
  NeedsClarification: ReplyNeedsClarificationConfig,
} as const;
export type ReplyOutcomeConfig = ValueOf<typeof ReplyOutcomeConfig>;

export interface ReplyRoutingRule {
  readonly match: {
    readonly stage?: readonly string[] | undefined;
    readonly outcome?: readonly ReplyOutcome[] | undefined;
  };
  readonly matchMode: MatchMode;
  readonly target: ReplyTarget;
}

export interface ReplyPublicationConfig {
  readonly rules: readonly ReplyRoutingRule[];
  readonly default: ReplyTarget;
}
