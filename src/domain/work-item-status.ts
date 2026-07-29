import { z } from 'zod';

import type { Stage } from './types.js';

// Canonical, typed status for a work item — folded once in
// projection-updater.ts, translated (never recomputed) everywhere else
// (e.g. GitHub labels via labelsForWorkItem). See
// docs/superpowers/specs/2026-07-28-canonical-work-item-status-design.md.
export const workItemStatusValues = [
  'queued',
  'working',
  'awaiting-approval',
  'changes-requested',
  'blocked',
  'done',
  'failed',
] as const;

export type WorkItemStatus = (typeof workItemStatusValues)[number];

export const workItemStatusSchema = z.enum(workItemStatusValues);

// Mirrors the sentinel/stage mapping that used to live only in
// tick-runner.ts's statusLabelForOutcome/statusLabelForStage. Folded onto
// context.status alongside (not replacing) context.lastRunSentinel.
export function workItemStatusForRunOutcome(input: {
  sentinel: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
  stage: Stage;
}): WorkItemStatus {
  if (input.sentinel === 'AWAITING_APPROVAL') {
    return 'awaiting-approval';
  }
  if (input.sentinel === 'BLOCKED') {
    return 'blocked';
  }
  if (input.sentinel === 'FAILED') {
    return 'failed';
  }
  return input.stage === 'done' ? 'done' : 'queued';
}
