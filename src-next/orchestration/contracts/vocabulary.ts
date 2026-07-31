import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const TransitionTargetKind = defineClosedVocabulary({
  Stage: 'stage',
  Complete: 'complete',
  AwaitSignal: 'await-signal',
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
