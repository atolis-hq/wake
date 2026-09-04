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
