import {
  ActivityOutcomeKind,
  ActivityResourceRole,
  BuiltInActivityName,
  pullRequestMergeInputSchema,
} from '../../activities/index.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
  type WorkflowOrchestrationEvent,
} from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind } from '../contracts/vocabulary.js';
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
    const requireApproval =
      merges.length === 0 ||
      merges.some(
        (parsed) =>
          !parsed.success ||
          parsed.data.target !== ActivityResourceRole.Primary ||
          parsed.data.scope !== undefined ||
          parsed.data.requireApproval,
      );
    const history = await repository.history(child.workflowInstanceId);
    const accepted = acceptedReview(history.events);
    const review =
      accepted === undefined ? undefined : ((await repository.load(accepted)).view ?? undefined);
    return { requireApproval, review };
  };
}

function acceptedReview(events: readonly WorkflowOrchestrationEvent[]) {
  let watch: string | undefined;
  let accepted: string | undefined;
  for (const { event } of events) {
    if (
      event.eventType === Event.SignalWaitStarted &&
      event.payload.signalKind === WatchGateVerdictSignal
    ) {
      watch = event.payload.from?.find(
        (authority) => authority.kind === ApprovalAuthorityKind.Watch,
      )?.watch;
      accepted = undefined;
    }
    if (event.eventType === Event.SignalAccepted && event.payload.kind === WatchGateVerdictSignal) {
      const signal = event.payload;
      accepted =
        signal.outcome === ActivityOutcomeKind.Done &&
        signal.authority?.kind === ApprovalAuthorityKind.Watch &&
        signal.authority.watch === watch
          ? signal.providerEventId
          : undefined;
      watch = undefined;
    }
  }

  return accepted;
}
