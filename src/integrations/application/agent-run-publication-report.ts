import { BuiltInActivityName } from '../../activities/index.js';
import {
  ApprovalAuthorityKind,
  ApprovedSignal,
  isApprovalAwaitingSignalKind,
  isPolicyBlockedMergeWait,
  ResourceTransitionSignal,
  WatchGateVerdictSignal,
  WorkflowStatus,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';
import {
  MergeStageApprovalGuidance,
  MergeWaitGuidance,
  type projectTerminalAgentRunReport,
  type TerminalRun,
} from './terminal-agent-run-report.js';

/** The comment to post when a merge stage starts waiting, or undefined when no hint applies. */
export function mergeWaitComment(workflow: WorkflowInstanceView | undefined): string | undefined {
  if (workflow === undefined) return undefined;
  if (isMergePublicationWait(workflow)) return `**Wake: Awaiting merge**\n\n${MergeWaitGuidance}`;
  const waiting =
    workflow.status === WorkflowStatus.Waiting && workflow.parentWorkflowInstanceId === undefined;
  return waiting && isMergeStageApproval(workflow)
    ? `**Wake: Awaiting approval**\n\n${MergeStageApprovalGuidance}`
    : undefined;
}

export function agentRunReportInput(
  run: TerminalRun,
  stage: string | undefined,
  workflow: WorkflowInstanceView,
  allWorkflows: readonly WorkflowInstanceView[],
): Parameters<typeof projectTerminalAgentRunReport>[0] {
  const watchGateVerdict = watchGateVerdictFor(run, workflow, allWorkflows);
  const isWaiting =
    workflow.waitingFor !== undefined &&
    isApprovalAwaitingSignalKind(workflow.waitingFor.signalKind);
  const isMergeWait = isMergePublicationWait(workflow);
  return {
    run,
    ...(stage === undefined ? {} : { stage }),
    ...(isWaiting ? { awaitingApproval: true } : {}),
    ...(isMergeWait ? { awaitingMerge: true } : {}),
    ...(isMergeStageApproval(workflow) ? { mergeStageApproval: true } : {}),
    ...(watchGateVerdict === undefined ? {} : { watchGateVerdict }),
  };
}

export function isMergePublicationWait(
  workflow: WorkflowInstanceView | undefined,
): workflow is WorkflowInstanceView & {
  readonly pendingActivation: NonNullable<WorkflowInstanceView['pendingActivation']>;
} {
  return (
    workflow?.status === WorkflowStatus.Waiting &&
    workflow.parentWorkflowInstanceId === undefined &&
    workflow.waitingFor !== undefined &&
    workflow.waitingFor.intentEventId === undefined &&
    workflow.pendingActivation?.activity === BuiltInActivityName.PullRequestMerge &&
    (workflow.waitingFor.signalKind === ResourceTransitionSignal ||
      isPolicyBlockedMergeWait(workflow))
  );
}

/** An approved wait at the merge stage is resumed by /approved. */
export function isMergeStageApproval(workflow: WorkflowInstanceView): boolean {
  return (
    workflow.waitingFor?.signalKind === ApprovedSignal &&
    workflow.pendingActivation?.activity === BuiltInActivityName.PullRequestMerge
  );
}

function watchGateVerdictFor(
  run: TerminalRun,
  workflow: WorkflowInstanceView,
  allWorkflows: readonly WorkflowInstanceView[],
): { readonly runId: string } | undefined {
  if (run.agent?.outcome !== 'DONE' && run.agent?.outcome !== 'REJECTED') return undefined;
  if (workflow.parentWorkflowInstanceId === undefined || workflow.watchId === undefined)
    return undefined;
  const parent = allWorkflows.find(
    (value) => value.workflowInstanceId === workflow.parentWorkflowInstanceId,
  );
  if (parent?.waitingFor?.signalKind !== WatchGateVerdictSignal) return undefined;
  const namesThisWatch = parent.waitingFor.from?.some(
    (entry) => entry.kind === ApprovalAuthorityKind.Watch && entry.watch === workflow.watchId,
  );
  return namesThisWatch === true ? { runId: run.runId } : undefined;
}
