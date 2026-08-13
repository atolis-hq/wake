import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';
import { activityName } from './identifiers.js';

export const ActivityExecutionKind = defineClosedVocabulary({
  Agent: 'agent',
  Script: 'script',
  Deterministic: 'deterministic',
} as const);

export type ActivityExecutionKind = ValueOf<typeof ActivityExecutionKind>;

export const ActivityWorkspaceMode = defineClosedVocabulary({
  ReadOnly: 'read-only',
  Branch: 'branch',
} as const);

export type ActivityWorkspaceMode = ValueOf<typeof ActivityWorkspaceMode>;

export const ActivityResourceCardinality = defineClosedVocabulary({
  ZeroOrOne: 'zero-or-one',
  ExactlyOne: 'exactly-one',
  OneOrMore: 'one-or-more',
} as const);

export type ActivityResourceCardinality = ValueOf<typeof ActivityResourceCardinality>;

export const ActivityResourceRole = defineClosedVocabulary({
  Primary: 'primary',
  Secondary: 'secondary',
} as const);

export type ActivityResourceRole = ValueOf<typeof ActivityResourceRole>;

export const ExternalExecutionKind = defineClosedVocabulary({
  Process: 'process',
  RemoteSession: 'remote-session',
} as const);

export type ExternalExecutionKind = ValueOf<typeof ExternalExecutionKind>;

export const RetrySafety = defineClosedVocabulary({
  SafeToRetry: 'safe-to-retry',
  RequiresReconciliation: 'requires-reconciliation',
} as const);

export type RetrySafety = ValueOf<typeof RetrySafety>;

export const ActivityFailureCode = defineClosedVocabulary({
  IntentWriteFailed: 'intent-write-failed',
  InvalidAgentResult: 'invalid-agent-result',
  AmbiguousRunnerResult: 'ambiguous-runner-result',
  RunnerFailed: 'runner-failed',
} as const);

export type ActivityFailureCode = ValueOf<typeof ActivityFailureCode>;

export const ActivityOutcomeKind = defineClosedVocabulary({
  Waiting: 'waiting',
  Done: 'done',
  Rejected: 'rejected',
  Blocked: 'blocked',
  Failed: 'failed',
} as const);

export type ActivityOutcomeKind = ValueOf<typeof ActivityOutcomeKind>;

export const ActivityRunnerTransportStatus = defineClosedVocabulary({
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Ambiguous: 'ambiguous',
} as const);

export type ActivityRunnerTransportStatus = ValueOf<typeof ActivityRunnerTransportStatus>;

export const IntentAppendStatus = defineClosedVocabulary({
  Appended: 'appended',
  Known: 'known',
  Ambiguous: 'ambiguous',
  Failed: 'failed',
} as const);

export type IntentAppendStatus = ValueOf<typeof IntentAppendStatus>;

export const BuiltInActivityName = {
  Agent: activityName(ActivityExecutionKind.Agent),
  PullRequestApprove: activityName('pr.approve'),
  PullRequestMerge: activityName('pr.merge'),
} as const;
