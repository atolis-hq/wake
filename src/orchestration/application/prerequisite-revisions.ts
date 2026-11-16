import { ActivityOutcomeKind } from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import type { DelegationArtifacts } from '../contracts/delegation-ports.js';
import type { DelegationInputs } from '../contracts/delegation.js';
import type { OrchestrationSignal } from '../contracts/events.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
  type SignalExpectation,
  type WorkflowOrchestrationEvent,
} from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind, TransitionTargetKind } from '../contracts/vocabulary.js';

/** Only an accepted watch rejection with an explicit configured stage route grants recovery. */
export function prerequisiteRevisions(events: readonly WorkflowOrchestrationEvent[]) {
  const waits = new Map<string, SignalExpectation>();
  const targets = new Map<string, string | null>();
  const revisions = new Map<string, Set<string>>();
  const pending = new Map<string, string | undefined>();
  for (const { stream, event } of events) {
    const id = stream.id;
    if (event.eventType === Event.SignalWaitStarted) waits.set(id, event.payload);
    if (event.eventType === Event.SignalAccepted) {
      const target = rejectedRoute(waits.get(id), event.payload);
      if (target !== undefined) {
        targets.set(id, target);
        pending.set(id, undefined);
      }
      waits.delete(id);
    }
    if (event.eventType === Event.DelegationInputsRefreshed) targets.set(id, null);
    if (event.eventType !== Event.ActivityRequested || !targets.has(id)) continue;
    const target = targets.get(id);
    targets.delete(id);
    if (
      (target === null || event.payload.stage === target) &&
      event.payload.execution?.workspace === WorkspaceMode.Branch
    ) {
      const activation = event.payload.activationId;
      const known = new Set(revisions.get(id));
      known.add(activation);
      revisions.set(id, known);
      pending.set(id, activation);
    }
  }
  return { revisions, pending };
}

function rejectedRoute(wait: SignalExpectation | undefined, signal: OrchestrationSignal) {
  const acceptedAuthority = signal.authority;
  if (
    wait?.signalKind === WatchGateVerdictSignal &&
    wait.onRejectResume?.kind === TransitionTargetKind.Stage &&
    signal.kind === WatchGateVerdictSignal &&
    signal.outcome === ActivityOutcomeKind.Rejected &&
    acceptedAuthority?.kind === ApprovalAuthorityKind.Watch &&
    wait.from?.some(
      (authority) =>
        authority.kind === ApprovalAuthorityKind.Watch &&
        authority.watch === acceptedAuthority.watch,
    )
  )
    return wait.onRejectResume.stage;
  return undefined;
}

export function revisionPending(
  workflow: WorkflowInstanceView,
  pending: ReadonlyMap<string, string | undefined>,
) {
  return (
    pending.has(workflow.workflowInstanceId) &&
    !workflow.acceptedOutcomes.some((id) => id === pending.get(workflow.workflowInstanceId))
  );
}

export async function revisionOutputPending(
  workflow: WorkflowInstanceView,
  reference: DelegationInputs['consumed'][number]['reference'],
  artifacts: DelegationArtifacts,
  pending: ReadonlyMap<string, string | undefined>,
) {
  if (!('runId' in reference) || !pending.has(workflow.workflowInstanceId)) return false;
  return (
    (await artifacts.runActivation?.(reference.runId)) !== pending.get(workflow.workflowInstanceId)
  );
}
