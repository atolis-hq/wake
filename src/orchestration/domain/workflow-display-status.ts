import { ActivityOutcomeKind } from '../../activities/index.js';
import { isApprovalAwaitingSignalKind } from '../contracts/events.js';
import type { SignalName } from '../contracts/identifiers.js';
import { WorkflowDisplayStatus, WorkflowStatus } from '../contracts/vocabulary.js';

/** Operator-facing status; durable workflow state remains unchanged. */
export function workflowDisplayStatus(workflow: {
  readonly status: WorkflowStatus;
  readonly waitingFor?: { readonly signalKind: SignalName } | undefined;
}): WorkflowDisplayStatus {
  switch (workflow.status) {
    case WorkflowStatus.Active:
      return WorkflowDisplayStatus.Working;
    case WorkflowStatus.Waiting: {
      const signal = workflow.waitingFor?.signalKind;
      if (signal !== undefined && isApprovalAwaitingSignalKind(signal))
        return WorkflowDisplayStatus.AwaitingApproval;
      if (signal === ActivityOutcomeKind.Blocked) return WorkflowDisplayStatus.Blocked;
      if (signal === ActivityOutcomeKind.Failed) return WorkflowDisplayStatus.Failed;
      return WorkflowDisplayStatus.Working;
    }
    case WorkflowStatus.Blocked:
      return WorkflowDisplayStatus.Blocked;
    case WorkflowStatus.Completed:
      return WorkflowDisplayStatus.Completed;
    case WorkflowStatus.Superseded:
      return WorkflowDisplayStatus.Failed;
  }
}
