import { ActivityOutcomeKind } from '../../activities/index.js';
import { WatchGateVerdictSignal } from '../contracts/events.js';
import type { SignalExpectationView, WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind, WorkflowStatus } from '../contracts/vocabulary.js';

export function parentWaitsForWatch(parent: WorkflowInstanceView, watchId: string): boolean {
  if (parent.status !== WorkflowStatus.Waiting) return false;
  const watchIds = watchIdsFor(parent.waitingFor);
  return watchIds.includes(watchId);
}

export function watchIdsFor(wait: SignalExpectationView | undefined): readonly string[] {
  if (wait?.from === undefined) return [];
  return (wait.from ?? []).flatMap((authority) =>
    authority.kind === ApprovalAuthorityKind.Watch ? [authority.watch] : [],
  );
}

export function watchGateVerdictOutcome(
  parent: WorkflowInstanceView,
  child: WorkflowInstanceView,
): typeof ActivityOutcomeKind.Done | typeof ActivityOutcomeKind.Rejected | undefined {
  if (parent.waitingFor?.signalKind !== WatchGateVerdictSignal) return undefined;
  return child.lastOutcome?.kind === ActivityOutcomeKind.Done
    ? ActivityOutcomeKind.Done
    : ActivityOutcomeKind.Rejected;
}
