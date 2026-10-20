import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const TransitionTargetKind = defineClosedVocabulary({
  Stage: 'stage',
  Complete: 'complete',
  AwaitSignal: 'await-signal',
  ResourceTransitionWait: 'resource-transition-wait',
} as const);

export type TransitionTargetKind = ValueOf<typeof TransitionTargetKind>;

export const WorkflowStatus = defineClosedVocabulary({
  Active: 'active',
  Waiting: 'waiting',
  Completed: 'completed',
  Blocked: 'blocked',
  Superseded: 'superseded',
} as const);

export type WorkflowStatus = ValueOf<typeof WorkflowStatus>;

export const ActivityActivationStatus = defineClosedVocabulary({
  Pending: 'pending',
  Running: 'running',
  Waiting: 'waiting',
  Completed: 'completed',
} as const);

export type ActivityActivationStatus = ValueOf<typeof ActivityActivationStatus>;

export const WorkflowInstanceKind = defineClosedVocabulary({
  Primary: 'primary',
  Child: 'child',
} as const);

export type WorkflowInstanceKind = ValueOf<typeof WorkflowInstanceKind>;

// Who may satisfy a wait. Distinct from EventActorKind: that vocabulary answers
// who emitted an event (provenance); this answers who may open a gate (authority).
export const ApprovalAuthorityKind = defineClosedVocabulary({
  Human: 'human',
  Auto: 'auto',
  Watch: 'watch',
} as const);

export type ApprovalAuthorityKind = ValueOf<typeof ApprovalAuthorityKind>;

export const ConversationBuiltInCommand = defineClosedVocabulary({
  Approved: '/approved',
  Accepted: '/accepted',
  Changes: '/changes',
  Retry: '/retry',
  Restart: '/restart',
  Extend: '/extend',
} as const);

export type ConversationBuiltInCommand = ValueOf<typeof ConversationBuiltInCommand>;

export const ConversationSurfaceCapability = defineClosedVocabulary({
  Review: 'review-surface',
  Chat: 'chat-surface',
  Operator: 'operator-surface',
} as const);

export type ConversationSurfaceCapability = ValueOf<typeof ConversationSurfaceCapability>;

export const DelegationOutputKind = defineClosedVocabulary({ Change: 'change' } as const);

export const DelegationPrerequisiteCondition = defineClosedVocabulary({
  AcceptedOutput: 'accepted-output',
  PushedChange: 'pushed-change',
  DeliveryReady: 'delivery-ready',
  MergedChange: 'merged-change',
} as const);

export const DelegationBlockerKind = defineClosedVocabulary({
  /** Terminal failure, cancellation, exhausted budget or a changed consumed input. */
  Failed: 'failed',
  /** A child workflow blocked for assignment clarification the parent may answer. */
  Context: 'assignment-context',
} as const);

export type DelegationBlockerKind = ValueOf<typeof DelegationBlockerKind>;

export const DelegationAttentionRejection = defineClosedVocabulary({
  NoAttention: 'no-attention',
  OutsideHierarchy: 'outside-hierarchy',
  UnknownBlocker: 'unknown-blocker',
  NotAnswerable: 'not-answerable',
  StaleRevision: 'stale-revision',
  NotBlocked: 'not-blocked',
  Duplicate: 'duplicate',
} as const);

export type DelegationAttentionRejection = ValueOf<typeof DelegationAttentionRejection>;

export const DelegationConflictCode = defineClosedVocabulary({
  SelfDependency: 'self-dependency',
  MissingTarget: 'missing-target',
  MissingOutput: 'missing-output',
  OutputKind: 'output-kind',
  CrossRepositoryBase: 'cross-repository-base',
  CrossRepositoryChange: 'cross-repository-change',
  MultipleBases: 'multiple-bases',
  WaitCycle: 'wait-cycle',
  StalePlan: 'stale-plan',
  AttentionOpen: 'attention-open',
  ReplacementUnsupported: 'replacement-unsupported',
  ReplacementInvalid: 'replacement-invalid',
} as const);

export type DelegationConflictCode = ValueOf<typeof DelegationConflictCode>;

export const PrerequisiteBlockCode = defineClosedVocabulary({
  Waiting: 'prerequisite-waiting',
  Changed: 'prerequisite-changed',
  Failed: 'prerequisite-failed',
  Unavailable: 'prerequisite-unavailable',
  Cycle: 'prerequisite-cycle',
  Blocked: 'prerequisite-blocked',
} as const);

export type PrerequisiteBlockCode = ValueOf<typeof PrerequisiteBlockCode>;

export const DeliveryRejection = defineClosedVocabulary({
  /** The submitted revision is not the current one; re-inspect before retrying. */
  StaleSelection: 'stale-selection',
  /** An original required assignment has no qualifying output or authorized replacement. */
  UncoveredRequirement: 'uncovered-requirement',
  UnknownRequirement: 'unknown-requirement',
  /** The named output is not a qualifying result of the claimed child. */
  OutputMismatch: 'output-mismatch',
  /** A replacement did not name the output currently selected, or is not criteria-preserving. */
  ReplacementConflict: 'replacement-conflict',
  /** The selection still contains results whose upstream input was replaced. */
  StaleOutput: 'stale-output',
  NoSelection: 'no-selection',
  CandidateCoverage: 'candidate-coverage',
  /** A retained ref is missing, outside the delivery namespace, or no longer at its recorded commit. */
  SourceUnavailable: 'source-unavailable',
  UnknownCandidate: 'unknown-candidate',
  /** QA named revisions other than the candidate's exact set. */
  RevisionMismatch: 'revision-mismatch',
  InvalidVerdict: 'invalid-verdict',
  /** An identity was reused for different content. */
  Conflict: 'identity-conflict',
} as const);

export type DeliveryRejection = ValueOf<typeof DeliveryRejection>;

export const QaVerdict = defineClosedVocabulary({
  Pass: 'pass',
  Fail: 'fail',
  /** The environment or a source was unavailable; never a pass. */
  Blocked: 'blocked',
} as const);

export type QaVerdict = ValueOf<typeof QaVerdict>;

export const CandidateSourceKind = defineClosedVocabulary({
  /** The selected output revision is itself the tip (a single change or an intentional stack). */
  Output: 'output',
  /** An agent-assembled commit published under the delivery's retained ref namespace. */
  RetainedRef: 'retained-ref',
} as const);

export type CandidateSourceKind = ValueOf<typeof CandidateSourceKind>;

export const DeliveryCompletion = defineClosedVocabulary({
  /** The parent may finish once the current candidate has an effective QA pass. */
  QaApproved: 'qa-approved',
  /** The parent additionally needs governed integration, which is not yet available. */
  MergeRequired: 'merge-required',
} as const);

export type DeliveryCompletion = ValueOf<typeof DeliveryCompletion>;
