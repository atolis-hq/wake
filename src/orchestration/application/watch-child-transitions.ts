import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind } from '../contracts/vocabulary.js';

export function continuesWaitingForSameWatchGate(
  before: WorkflowInstanceView,
  after: WorkflowInstanceView | null,
): boolean {
  if (before.waitingFor === undefined || after?.waitingFor === undefined) return false;
  if (
    before.status !== after.status ||
    before.waitingFor.signalKind !== after.waitingFor.signalKind
  )
    return false;
  const watches = (wait: NonNullable<WorkflowInstanceView['waitingFor']>) =>
    (wait.from ?? [])
      .filter((authority) => authority.kind === ApprovalAuthorityKind.Watch)
      .map((authority) => authority.watch)
      .sort();
  return JSON.stringify(watches(before.waitingFor)) === JSON.stringify(watches(after.waitingFor));
}
