export const AUTONOMOUS_DECISION_AUDIT_EVENT = 'wake.audit.autonomous-decision';
export const CORRELATION_PRIMARY_CONFLICT_EVENT = 'wake.correlation.primary-conflict';
export const CORRELATION_REGISTERED_EVENT = 'wake.correlation.registered';
export const CORRELATION_RETRACTED_EVENT = 'wake.correlation.retracted';
export const LABELS_REQUESTED_EVENT = 'wake.labels.requested';
export const PR_AUTO_MERGE_ENABLED_EVENT = 'wake.pr-auto-merge.enabled';
export const PR_REVIEW_APPROVED_EVENT = 'wake.pr-review.approved';
export const PUBLISH_CONFIRMED_EVENT = 'wake.publish.confirmed';
export const PUBLISH_FAILED_EVENT = 'wake.publish.failed';
export const PUBLISH_INTENT_REQUESTED_EVENT = 'wake.publish.intent.requested';
export const PUBLISH_SENT_UNCONFIRMED_EVENT = 'wake.publish.sent-unconfirmed';
export const RETRY_REQUESTED_EVENT = 'wake.retry.requested';
export const RUN_REQUESTED_EVENT = 'wake.run.requested';
export const RUN_CLAIMED_EVENT = 'wake.run.claimed';
export const RUN_COMPLETED_EVENT = 'wake.run.completed';
export const WORKFLOW_SELECTED_EVENT = 'wake.workflow.selected';
export const WORK_ITEM_CREATED_EVENT = 'wake.workitem.created';
export const WORK_ITEM_DELETED_EVENT = 'wake.workitem.deleted';
export const WORK_ITEM_FROZEN_EVENT = 'wake.workitem.frozen';
export const WORK_ITEM_UNFROZEN_EVENT = 'wake.workitem.unfrozen';
export const WORKSPACE_CLEANED_EVENT = 'wake.workspace.cleaned';
export const WORKSPACE_CLEANUP_FAILED_EVENT = 'wake.workspace.cleanup-failed';

export const wakeEventTypeValues = [
  AUTONOMOUS_DECISION_AUDIT_EVENT,
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  CORRELATION_REGISTERED_EVENT,
  CORRELATION_RETRACTED_EVENT,
  LABELS_REQUESTED_EVENT,
  PR_AUTO_MERGE_ENABLED_EVENT,
  PR_REVIEW_APPROVED_EVENT,
  PUBLISH_CONFIRMED_EVENT,
  PUBLISH_FAILED_EVENT,
  PUBLISH_INTENT_REQUESTED_EVENT,
  PUBLISH_SENT_UNCONFIRMED_EVENT,
  RETRY_REQUESTED_EVENT,
  RUN_REQUESTED_EVENT,
  RUN_CLAIMED_EVENT,
  RUN_COMPLETED_EVENT,
  WORKFLOW_SELECTED_EVENT,
  WORK_ITEM_CREATED_EVENT,
  WORK_ITEM_DELETED_EVENT,
  WORK_ITEM_FROZEN_EVENT,
  WORK_ITEM_UNFROZEN_EVENT,
  WORKSPACE_CLEANED_EVENT,
  WORKSPACE_CLEANUP_FAILED_EVENT,
] as const;

export type WakeEventType = (typeof wakeEventTypeValues)[number];

export type WakeEventTypeDefinition = {
  type: WakeEventType;
  description: string;
  payloadShape: string;
};

export const wakeEventTypeDefinitions = [
  {
    type: AUTONOMOUS_DECISION_AUDIT_EVENT,
    description: 'Records an autonomous workflow decision and the inputs used to make it.',
    payloadShape:
      '{ decisionType, workItemId, runId, workflowRevision, inputsConsidered, outcome, timestamp }',
  },
  {
    type: CORRELATION_PRIMARY_CONFLICT_EVENT,
    description:
      'Warns that a requested primary resource correlation was downgraded because another work item already owns the resource.',
    payloadShape: '{ resourceUri, incumbentWorkItemKey }',
  },
  {
    type: CORRELATION_REGISTERED_EVENT,
    description: 'Registers a resource URI as correlated to a work item.',
    payloadShape: '{ resourceUri, role, relation, provenance, registeredBy? }',
  },
  {
    type: CORRELATION_RETRACTED_EVENT,
    description: 'Removes a resource URI correlation from a work item.',
    payloadShape: '{ resourceUri }',
  },
  {
    type: LABELS_REQUESTED_EVENT,
    description: 'Requests outbound synchronization of Wake status, stage, and workflow labels.',
    payloadShape:
      "{ statusLabel, stageLabel, workflowLabel, origin, idempotencyKey, deliveryState: 'PENDING' }",
  },
  {
    type: PR_AUTO_MERGE_ENABLED_EVENT,
    description: 'Records that Wake enabled auto-merge for an approved pull request.',
    payloadShape: '{ idempotencyKey }',
  },
  {
    type: PR_REVIEW_APPROVED_EVENT,
    description: 'Records that Wake approved a pull request review after approval policy passed.',
    payloadShape: '{ idempotencyKey }',
  },
  {
    type: PUBLISH_CONFIRMED_EVENT,
    description:
      'Confirms that an outbound publish intent was delivered or intentionally suppressed.',
    payloadShape: "{ intentEventId, idempotencyKey, deliveryState: 'CONFIRMED', ...sinkDetails }",
  },
  {
    type: PUBLISH_FAILED_EVENT,
    description: 'Records a failed outbound publish attempt for bounded retry.',
    payloadShape:
      "{ intentEventId, intentEventType, idempotencyKey, deliveryState: 'PENDING', error }",
  },
  {
    type: PUBLISH_INTENT_REQUESTED_EVENT,
    description: 'Requests an outbound comment, reply, status update, question, or approval card.',
    payloadShape:
      "{ kind, origin, body, action, sentinel, runId, idempotencyKey, deliveryState: 'PENDING', sessionId?, model?, cli?, duration?, tokens?, cost?, workspacePath?, failureRepeated?, previousFailureClass? }",
  },
  {
    type: PUBLISH_SENT_UNCONFIRMED_EVENT,
    description: 'Marks an outbound publish intent as sent before Wake has observed confirmation.',
    payloadShape:
      "{ intentEventId, intentEventType, idempotencyKey, deliveryState: 'SENT_UNCONFIRMED' }",
  },
  {
    type: RETRY_REQUESTED_EVENT,
    description: 'Requests that a failed work item be retried.',
    payloadShape: '{ requestedBy }',
  },
  {
    type: RUN_REQUESTED_EVENT,
    description: 'Requests that a scheduled work item be run immediately.',
    payloadShape: '{ requestedBy }',
  },
  {
    type: RUN_CLAIMED_EVENT,
    description: 'Records that Wake claimed a work item for an agent run.',
    payloadShape:
      '{ action, priorStage, claimedStage?, sourceRevision, watcherRun?, watcherTrigger? }',
  },
  {
    type: RUN_COMPLETED_EVENT,
    description: 'Records the terminal result of an agent run or internal lifecycle transition.',
    payloadShape:
      '{ action?, sentinel, nextStage?, runId, sessionId?, sessionCli?, workspacePath?, reason?, handledCommentId?, failureClass?, blockReason?, executionOutcome?, workflowOutcome?, watcherRun?, allowAutoApproval?, body? }',
  },
  {
    type: WORKFLOW_SELECTED_EVENT,
    description: 'Pins the workflow selected for a newly minted work item.',
    payloadShape: '{ workflow, selectedFromEventId }',
  },
  {
    type: WORK_ITEM_CREATED_EVENT,
    description: 'Mints a Wake work item identity before resource correlation is registered.',
    payloadShape: '{}',
  },
  {
    type: WORK_ITEM_DELETED_EVENT,
    description: 'Soft-deletes a work item and excludes it from board display and execution.',
    payloadShape: '{ requestedBy }',
  },
  {
    type: WORK_ITEM_FROZEN_EVENT,
    description: 'Marks a work item as frozen so runner ticks will not execute it.',
    payloadShape: '{ requestedBy }',
  },
  {
    type: WORK_ITEM_UNFROZEN_EVENT,
    description: 'Clears a work item freeze so runner ticks may execute it again.',
    payloadShape: '{ requestedBy }',
  },
  {
    type: WORKSPACE_CLEANED_EVENT,
    description: 'Records successful cleanup of a closed issue workspace.',
    payloadShape: '{ workspacePath }',
  },
  {
    type: WORKSPACE_CLEANUP_FAILED_EVENT,
    description: 'Records a workspace cleanup failure without aborting the cleanup sweep.',
    payloadShape: '{ workspacePath, error }',
  },
] satisfies WakeEventTypeDefinition[];
