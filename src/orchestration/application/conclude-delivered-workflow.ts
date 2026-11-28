import type { CommandContext } from '@atolis-hq/eventing';
import {
  ActivityEventType,
  ActivityOutcomeKind,
  BuiltInActivityName,
  PullRequestState,
} from '../../activities/index.js';
import type {
  CompiledResourceTransition,
  CompiledWorkflow,
  TransitionTarget,
} from '../contracts/config.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { TransitionTargetKind, WorkflowStatus } from '../contracts/vocabulary.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import { acceptResourceTransition } from './resource-transition-matching.js';
import type { StartWorkflow } from './start-workflow.js';

/** External issue completion satisfies only the terminal issue-completion step after our merge. */
export async function concludeDeliveredWorkflow(
  repository: OrchestrationRepository,
  workflows: StartWorkflow,
  id: WorkflowInstanceId,
  context: CommandContext,
): Promise<void> {
  const loaded = await repository.load(id);
  const view = loaded.view;
  if (view === null || !isDeliveredMergeWait(view)) return;
  const definition = await workflows.definitionForOperation(view, loaded.sequence, context);
  if (definition === null) return;
  const transitions = view.waitingFor?.resourceTransitions?.filter(isMergedTransition);
  if (transitions?.length !== 1) return;
  const target = terminalCompletionTarget(definition, transitions[0]!.target);
  if (target === null) return;
  // The successful merge is already durable; external closure proves the remaining
  // deterministic issue-completion effect. Retain that outcome rather than inventing one.
  await acceptResourceTransition(
    repository,
    workflows,
    id,
    target,
    `${context.commandId}:delivered-merge`,
    { ...context, expectedSequence: loaded.sequence },
  );
}

function terminalCompletionTarget(
  definition: CompiledWorkflow,
  target: TransitionTarget,
): TransitionTarget | null {
  if (target.kind === TransitionTargetKind.Complete) return target;
  if (target.kind !== TransitionTargetKind.Stage) return null;
  const stage = definition.stages[target.stage];
  const route = stage?.on[ActivityOutcomeKind.Done];
  if (stage?.activity !== BuiltInActivityName.IssueComplete || route === undefined) return null;
  const guarded = [route.activities, route.await, route.watchGates, route.resourceTransitions].some(
    (guard) => guard !== undefined,
  );
  return !guarded && route.target.kind === TransitionTargetKind.Complete ? route.target : null;
}

function isMergedTransition(transition: CompiledResourceTransition): boolean {
  return (
    transition.event === ActivityEventType.PrStateChanged &&
    transition.where !== undefined &&
    'state' in transition.where &&
    transition.where.state === PullRequestState.Merged
  );
}

function isDeliveredMergeWait(view: WorkflowInstanceView): boolean {
  return (
    view.status === WorkflowStatus.Waiting &&
    view.pendingActivation?.activity === BuiltInActivityName.PullRequestMerge &&
    view.lastOutcome?.kind === ActivityOutcomeKind.Done
  );
}
