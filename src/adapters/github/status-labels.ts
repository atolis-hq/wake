import { stageLabelForStage } from '../../domain/stages.js';
import type { IssueStateRecord, WakeConfig } from '../../domain/types.js';
import { FROZEN_WORK_ITEM_LABEL } from '../../domain/work-item-lifecycle.js';
import type { WorkItemStatus } from '../../domain/work-item-status.js';
import { workflowLabelForWorkflowName, workflowNameForProjection } from '../../domain/workflows.js';

// Only Wake's GitHub adapter knows the wake:* label string convention — this
// is the single place that translates the canonical, typed context fields
// (status/frozen/deleted/scheduled) into label strings. core/ never computes
// labels itself; it just reads the current projection and calls this.
export const SCHEDULED_WORKFLOW_LABEL = 'wake:scheduled-workflow';

const statusLabelByStatus: Record<WorkItemStatus, string> = {
  queued: 'wake:status.pending',
  working: 'wake:status.working',
  'awaiting-approval': 'wake:status.awaiting-approval',
  'changes-requested': 'wake:status.changes-requested',
  blocked: 'wake:status.blocked',
  done: 'wake:status.completed',
  failed: 'wake:status.failed',
};

export interface WorkItemLabels {
  statusLabel: string;
  stageLabel: string;
  workflowLabel: string;
  frozenLabel?: string;
  scheduledLabel?: string;
}

// A projection that predates context.status being folded (or hasn't had a
// run complete yet since this design shipped) has no status field — fall
// back to the same sentinel+stage heuristic the old statusLabelForOutcome
// used, so an untouched legacy item is translated to the *same* label it
// already carries (e.g. still-AWAITING_APPROVAL) instead of drifting to a
// wrong one just because context.status hasn't been folded onto it yet.
function legacyStatusFallback(projection: IssueStateRecord): WorkItemStatus {
  const sentinel = projection.context.lastRunSentinel;
  if (sentinel === 'AWAITING_APPROVAL') {
    return 'awaiting-approval';
  }
  if (sentinel === 'BLOCKED') {
    return 'blocked';
  }
  if (sentinel === 'FAILED') {
    return 'failed';
  }
  return projection.wake.stage === 'done' ? 'done' : 'queued';
}

export function labelsForWorkItem(
  projection: IssueStateRecord,
  config: WakeConfig,
): WorkItemLabels {
  const statusLabel =
    statusLabelByStatus[projection.context.status ?? legacyStatusFallback(projection)];

  return {
    statusLabel,
    stageLabel: stageLabelForStage(projection.wake.stage),
    workflowLabel: workflowLabelForWorkflowName(workflowNameForProjection(projection, config)),
    ...(projection.context.frozen !== undefined ? { frozenLabel: FROZEN_WORK_ITEM_LABEL } : {}),
    ...(projection.context.scheduled === true ? { scheduledLabel: SCHEDULED_WORKFLOW_LABEL } : {}),
  };
}
