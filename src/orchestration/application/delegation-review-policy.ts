import {
  ActivityOutcomeKind,
  ActivityResourceRole,
  BuiltInActivityName,
  pullRequestMergeInputSchema,
} from '../../activities/index.js';
import type { DelegationReviewRefresh } from '../contracts/delegation.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
  type OrchestrationSignal,
  type WorkflowOrchestrationEvent,
} from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind, WorkflowStatus } from '../contracts/vocabulary.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { WorkflowDefinitionRegistry } from './workflow-definition-registry.js';

/** Read the pinned merge policy and accepted configured watch verdicts, never issue prose. */
export function createDelegationReviewPolicy(
  repository: OrchestrationRepository,
  definitions: WorkflowDefinitionRegistry,
) {
  return async (child: WorkflowInstanceView) => {
    const definition = await definitions.resolve(child, { journalFallback: true });
    const merges = Object.values(definition.stages)
      .flatMap((stage) => [
        { use: stage.activity, with: stage.with },
        ...Object.values(stage.on).flatMap((route) => route.activities ?? []),
      ])
      .filter((activity) => activity.use === BuiltInActivityName.PullRequestMerge)
      .map((activity) => pullRequestMergeInputSchema.safeParse(activity.with));
    // Without a merge policy, either trusted PR review or an exact-head watch review can qualify.
    const requireApproval = merges.some(
      (parsed) =>
        !parsed.success ||
        parsed.data.target !== ActivityResourceRole.Primary ||
        parsed.data.scope !== undefined ||
        parsed.data.requireApproval,
    );
    const history = await repository.history(child.workflowInstanceId);
    const { accepted, refresh } = acceptedReview(history.events);
    const review =
      accepted === undefined ? undefined : ((await repository.load(accepted)).view ?? undefined);
    return {
      requireApproval,
      review:
        refresh === undefined ||
        (review?.status === WorkflowStatus.Completed &&
          review.lastOutcome?.kind === ActivityOutcomeKind.Done)
          ? review
          : undefined,
      refreshedSubject: refresh?.subject,
      allowTrustedReview: merges.length === 0,
    };
  };
}

function acceptedReview(events: readonly WorkflowOrchestrationEvent[]) {
  let refresh: DelegationReviewRefresh | undefined;
  let watch: string | undefined;
  let accepted: string | undefined;
  for (const { event } of events) {
    if (event.eventType === Event.DelegationReviewRefreshRequested) {
      refresh = event.payload;
      accepted = refresh.requestId;
      watch = undefined;
    }
    if (
      event.eventType === Event.SignalWaitStarted &&
      event.payload.signalKind === WatchGateVerdictSignal
    ) {
      refresh = undefined;
      watch = event.payload.from?.find(
        (authority) => authority.kind === ApprovalAuthorityKind.Watch,
      )?.watch;
      accepted = undefined;
    }
    if (event.eventType === Event.SignalAccepted && event.payload.kind === WatchGateVerdictSignal) {
      const signal = event.payload;
      accepted = acceptedWatchReview(signal, watch) ? signal.childWorkflowInstanceId : undefined;
      watch = undefined;
    }
  }

  return { accepted, refresh };
}

function acceptedWatchReview(signal: OrchestrationSignal, watch: string | undefined) {
  return (
    signal.outcome === ActivityOutcomeKind.Done &&
    signal.authority?.kind === ApprovalAuthorityKind.Watch &&
    signal.authority.watch === watch
  );
}
