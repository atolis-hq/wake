import type { CommandContext } from '@atolis-hq/eventing';
import {
  ActivityEventType,
  ActivityOutcomeKind,
  BuiltInActivityName,
  PullRequestState,
  readMergePolicyDenial,
} from '../../activities/index.js';
import type { CompiledResourceTransition, CompiledStage } from '../contracts/config.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { TransitionTargetKind, WorkflowStatus } from '../contracts/vocabulary.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { ResourceTransitionEvidence } from './resource-transition-evidence.js';
import { acceptResourceTransition } from './resource-transition-matching.js';
import type { StartWorkflow } from './start-workflow.js';

export async function recoverPolicyBlockedMerges(
  repository: OrchestrationRepository,
  workflows: StartWorkflow,
  evidence: ResourceTransitionEvidence,
  context: CommandContext,
): Promise<void> {
  for (const loaded of await repository.list()) {
    const view = loaded.view;
    if (view === null || !isPolicyBlockedMergeWait(view)) continue;
    const definition = await workflows.definitionForOperation(view, loaded.sequence, context);
    if (definition === null) continue;
    const stage = definition.stages[view.currentStage];
    if (!isBlockedRouteWait(stage, view)) continue;
    // The pinned definition supplies the completion destination, never current config.
    const transitions = mergedTransitions(stage);
    const activationId = view.acceptedOutcomes.at(-1);
    if (transitions === undefined || transitions.length !== 1 || activationId === undefined)
      continue;
    const resolved = await evidence.resolve({
      workItemId: view.workItemId,
      transitions,
      mergeDenialActivationId: activationId,
    });
    if (resolved === null) continue;
    await acceptResourceTransition(
      repository,
      workflows,
      view.workflowInstanceId,
      resolved.transition.target,
      resolved.evidenceId,
      { ...context, expectedSequence: loaded.sequence },
    );
  }
}

export function isPolicyBlockedMergeWait(view: WorkflowInstanceView): boolean {
  return (
    view.status === WorkflowStatus.Waiting &&
    view.parentWorkflowInstanceId === undefined &&
    view.waitingFor !== undefined &&
    view.waitingFor.intentEventId === undefined &&
    view.pendingActivation?.activity === BuiltInActivityName.PullRequestMerge &&
    readMergePolicyDenial(view.lastOutcome) !== null
  );
}

function isBlockedRouteWait(stage: CompiledStage | undefined, view: WorkflowInstanceView): boolean {
  const blocked = stage?.on[ActivityOutcomeKind.Blocked];
  return (
    stage?.activity === BuiltInActivityName.PullRequestMerge &&
    blocked?.target.kind === TransitionTargetKind.AwaitSignal &&
    blocked.target.signal === view.waitingFor?.signalKind
  );
}

function isMergedTransition(transition: CompiledResourceTransition): boolean {
  return (
    transition.event === ActivityEventType.PrStateChanged &&
    transition.where !== undefined &&
    'state' in transition.where &&
    transition.where.state === PullRequestState.Merged &&
    (transition.target.kind === TransitionTargetKind.Stage ||
      transition.target.kind === TransitionTargetKind.Complete)
  );
}

function mergedTransitions(stage: CompiledStage | undefined) {
  return stage?.on[ActivityOutcomeKind.Done]?.resourceTransitions?.filter(isMergedTransition);
}
