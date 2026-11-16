import { ActivityOutcomeKind } from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import type { DelegationArtifacts } from '../contracts/delegation-ports.js';
import type { DelegationInputs } from '../contracts/delegation.js';
import type { ActivityRequestedPayload, OrchestrationSignal } from '../contracts/events.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
  type SignalExpectation,
  type WorkflowOrchestrationEvent,
} from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind, TransitionTargetKind } from '../contracts/vocabulary.js';

/**
 * Only an accepted watch rejection with an explicit configured stage route opens a revision
 * episode. Every branch activation requested while it is open (retries, quota retries, follow-on
 * stages) belongs to it; the next wait closes it.
 */
export function prerequisiteRevisions(events: readonly WorkflowOrchestrationEvent[]) {
  const reviewRefreshes = new Map<string, Set<string>>();
  const waits = new Map<string, SignalExpectation>();
  const targets = new Map<string, string | null>();
  const open = new Set<string>();
  const revisions = new Map<string, Set<string>>();
  const pending = new Map<string, string | undefined>();
  for (const { stream, event } of events) {
    const id = stream.id;
    if (
      event.eventType === Event.DelegationReviewRefreshRequested &&
      'revision' in event.payload.subject.reference
    )
      reviewRefreshes.set(
        id,
        new Set(reviewRefreshes.get(id)).add(event.payload.subject.reference.revision),
      );
    if (event.eventType === Event.SignalWaitStarted) {
      waits.set(id, event.payload);
      open.delete(id);
    }
    if (event.eventType === Event.SignalAccepted) {
      const target = rejectedRoute(waits.get(id), event.payload);
      if (target !== undefined) {
        targets.set(id, target);
        open.delete(id);
        pending.set(id, undefined);
      }
      waits.delete(id);
    }
    if (event.eventType === Event.DelegationInputsRefreshed) {
      targets.set(id, null);
      open.delete(id);
    }
    if (event.eventType !== Event.ActivityRequested) continue;
    if (!inEpisode(id, event.payload, targets, open)) continue;
    const activation = event.payload.activationId;
    revisions.set(id, new Set(revisions.get(id)).add(activation));
    pending.set(id, activation);
  }
  return { revisions, pending, reviewRefreshes };
}

/** The first branch request must hit the configured target; later ones follow the open episode. */
function inEpisode(
  id: string,
  request: ActivityRequestedPayload,
  targets: Map<string, string | null>,
  open: Set<string>,
) {
  const branch = request.execution?.workspace === WorkspaceMode.Branch;
  if (!targets.has(id)) return open.has(id) && branch;
  const target = targets.get(id);
  targets.delete(id);
  if (!branch || (target !== null && request.stage !== target)) return false;
  open.add(id);
  return true;
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
  { pending, revisions }: ReturnType<typeof prerequisiteRevisions>,
) {
  if (!('runId' in reference) || !pending.has(workflow.workflowInstanceId)) return false;
  const activation = await artifacts.runActivation?.(reference.runId);
  return activation === undefined || !revisions.get(workflow.workflowInstanceId)?.has(activation);
}
