import type { CommandContext } from '@atolis-hq/eventing';
import {
  ActivityEventType,
  ActivityOutcomeKind,
  BuiltInActivityName,
  PullRequestCheckState,
  PullRequestMergeability,
  PullRequestState,
  readMergePolicyDenial,
} from '../../activities/index.js';
import type {
  CompiledOutcomeRoute,
  CompiledResourceTransition,
  CompiledStage,
  CompiledWorkflow,
} from '../contracts/config.js';
import {
  OrchestrationEventType,
  ResourceTransitionSignal,
  WatchGateVerdictSignal,
} from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { TransitionTargetKind, WorkflowStatus } from '../contracts/vocabulary.js';
import { stateDraft } from '../domain/decision-events.js';
import { finishRoute } from '../domain/transition.js';
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
    if (view === null || !isMergeWait(view)) continue;
    const definition = await workflows.definitionForOperation(view, loaded.sequence, context);
    if (definition === null) continue;
    const stage = definition.stages[view.currentStage];
    if (stage === undefined || !isConfiguredMergeWait(stage, view)) continue;
    if (await reconcileMergeProblem(repository, workflows, evidence, loaded, definition, context))
      continue;
    if (await recoverFailingChecks(repository, workflows, evidence, loaded, definition, context))
      continue;
    await recoverMergedPolicyWait(repository, workflows, evidence, loaded, stage, context);
  }
}

export function isPolicyBlockedMergeWait(view: WorkflowInstanceView): boolean {
  return isMergeWait(view) && readMergePolicyDenial(view.lastOutcome) !== null;
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

export const MergeWaitBlockReason = {
  Closed:
    'merge.pr-closed-unmerged: primary PR was closed without merging; restore the PR and resolve the workflow explicitly',
  Conflict:
    'merge.pr-conflicting: primary PR conflicts with its base; no safe bounded repair route in the pinned workflow',
  Exhausted:
    'merge.conflict-retry-exhausted: bounded conflict repair exhausted; resolve the PR and workflow explicitly',
} as const;

async function reconcileMergeProblem(
  repository: OrchestrationRepository,
  workflows: StartWorkflow,
  evidence: ResourceTransitionEvidence,
  loaded: Awaited<ReturnType<OrchestrationRepository['load']>>,
  definition: CompiledWorkflow,
  context: CommandContext,
): Promise<boolean> {
  const view = loaded.view!;
  const observed = await evidence.mergeWaitState?.(view.workItemId);
  if (observed === undefined || observed === null || observed.state === PullRequestState.Merged)
    return false;
  if (observed.state === PullRequestState.Closed) {
    await blockMergeWait(repository, loaded, MergeWaitBlockReason.Closed, context);
    return true;
  }
  if (observed.mergeability !== PullRequestMergeability.Conflicting) return false;
  const route = safeConflictRoute(definition.stages[view.currentStage]!, definition, view);
  if (route === undefined) {
    await blockMergeWait(repository, loaded, MergeWaitBlockReason.Conflict, context);
    return true;
  }
  await acceptResourceTransition(
    repository,
    workflows,
    view.workflowInstanceId,
    route.target,
    `${observed.evidenceId}:${view.pendingActivation?.activationId}`,
    {
      ...context,
      expectedSequence: loaded.sequence,
      retry: {
        key: `${BuiltInActivityName.PullRequestMerge}:${PullRequestMergeability.Conflicting}`,
        max: route.retry!.max,
        exhaustedReason: MergeWaitBlockReason.Exhausted,
      },
    },
  );
  return true;
}

async function blockMergeWait(
  repository: OrchestrationRepository,
  loaded: Awaited<ReturnType<OrchestrationRepository['load']>>,
  reason: string,
  context: CommandContext,
): Promise<void> {
  const view = loaded.view!;
  await repository.append(view.workflowInstanceId, loaded.sequence, [
    stateDraft(
      view,
      {
        occurredAt: context.occurredAt,
        causationId: `${context.commandId}:${view.workflowInstanceId}`,
      },
      { eventType: OrchestrationEventType.InstanceBlocked, payload: { reason } },
      1,
    ),
  ]);
}

function isMergeWait(view: WorkflowInstanceView): boolean {
  return (
    view.status === WorkflowStatus.Waiting &&
    view.parentWorkflowInstanceId === undefined &&
    view.pendingActivation?.activity === BuiltInActivityName.PullRequestMerge &&
    view.pendingActivation.supplemental !== true &&
    view.waitingFor !== undefined &&
    view.waitingFor.intentEventId === undefined
  );
}

function isConfiguredMergeWait(
  stage: CompiledStage | undefined,
  view: WorkflowInstanceView,
): boolean {
  if (stage?.activity !== BuiltInActivityName.PullRequestMerge || view.lastOutcome === undefined)
    return false;
  const route = stage.on[view.lastOutcome.kind];
  return route !== undefined && configuredWaitSignal(route) === view.waitingFor?.signalKind;
}

function configuredWaitSignal(route: CompiledOutcomeRoute): string | undefined {
  if (route.watchGates !== undefined) return WatchGateVerdictSignal;
  if (route.resourceTransitions !== undefined) return ResourceTransitionSignal;
  if (route.await !== undefined) return route.await.signal;
  return route.target.kind === TransitionTargetKind.AwaitSignal ? route.target.signal : undefined;
}

function safeConflictRoute(
  stage: CompiledStage,
  definition: CompiledWorkflow,
  view: WorkflowInstanceView,
): CompiledResourceTransition | undefined {
  const routes =
    stage.on[ActivityOutcomeKind.Done]?.resourceTransitions?.filter(isConflictTransition) ?? [];
  const route = routes.length === 1 ? routes[0] : undefined;
  if (
    route?.retry === undefined ||
    route.retry.max > 2 ||
    route.target.kind !== TransitionTargetKind.Stage
  )
    return undefined;
  if (
    route.target.stage === view.currentStage ||
    definition.stages[route.target.stage]?.activity !== BuiltInActivityName.Agent
  )
    return undefined;
  return route;
}

function isConflictTransition(transition: CompiledResourceTransition): boolean {
  return (
    transition.event === ActivityEventType.PrStateChanged &&
    transition.where !== undefined &&
    'mergeability' in transition.where &&
    transition.where.mergeability === PullRequestMergeability.Conflicting
  );
}

async function recoverMergedPolicyWait(
  repository: OrchestrationRepository,
  workflows: StartWorkflow,
  evidence: ResourceTransitionEvidence,
  loaded: Awaited<ReturnType<OrchestrationRepository['load']>>,
  stage: CompiledStage,
  context: CommandContext,
): Promise<void> {
  const view = loaded.view!;
  if (!isPolicyBlockedMergeWait(view) || !isBlockedRouteWait(stage, view)) return;
  // The pinned definition supplies the completion destination, never current config.
  const transitions = mergedTransitions(stage);
  const activationId = view.acceptedOutcomes.at(-1);
  if (transitions === undefined || transitions.length !== 1 || activationId === undefined) return;
  const resolved = await evidence.resolve({
    workItemId: view.workItemId,
    transitions,
    mergeDenialActivationId: activationId,
  });
  if (resolved === null) return;
  await acceptResourceTransition(
    repository,
    workflows,
    view.workflowInstanceId,
    resolved.transition.target,
    resolved.evidenceId,
    { ...context, expectedSequence: loaded.sequence },
  );
}

async function recoverFailingChecks(
  repository: OrchestrationRepository,
  workflows: StartWorkflow,
  evidence: ResourceTransitionEvidence,
  loaded: Awaited<ReturnType<OrchestrationRepository['load']>>,
  definition: CompiledWorkflow,
  context: CommandContext,
): Promise<boolean> {
  const view = loaded.view!;
  const stage = definition.stages[view.currentStage]!;
  if (view.blockReason?.startsWith('merge.checks-retry-exhausted:')) return false;
  const transitions = stage.on[ActivityOutcomeKind.Done]?.resourceTransitions?.filter(
    (route) => route.event === ActivityEventType.PrChecksChanged && route.retry !== undefined,
  );
  if (transitions === undefined || transitions.length === 0) return false;
  const resolved = await evidence.resolve({ workItemId: view.workItemId, transitions });
  if (resolved === null) return false;
  const key = `${BuiltInActivityName.PullRequestMerge}:${PullRequestCheckState.Failing}`;
  if ((view.retryCounts[key] ?? 0) >= resolved.transition.retry!.max) {
    const reason = checksExhaustedReason(resolved.failingCheckNames);
    const decisionContext = {
      occurredAt: context.occurredAt,
      causationId: `${context.commandId}:${view.workflowInstanceId}`,
    };
    const events = [
      stateDraft(
        view,
        decisionContext,
        {
          eventType: OrchestrationEventType.InstanceBlocked,
          payload: { reason },
        },
        1,
      ),
    ];
    const route = stage.on[ActivityOutcomeKind.Blocked];
    if (route !== undefined)
      finishRoute(
        events,
        definition,
        view,
        {
          ...decisionContext,
          outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason } },
        },
        route,
      );
    await repository.append(view.workflowInstanceId, loaded.sequence, events);
  } else {
    await acceptResourceTransition(
      repository,
      workflows,
      view.workflowInstanceId,
      resolved.transition.target,
      `${resolved.evidenceId}:${view.pendingActivation?.activationId}`,
      {
        ...context,
        expectedSequence: loaded.sequence,
        retry: {
          key,
          max: resolved.transition.retry!.max,
          exhaustedReason: 'merge.checks-retry-exhausted',
        },
      },
    );
  }
  return true;
}

function checksExhaustedReason(names: readonly string[] | undefined): string {
  const detail =
    names === undefined || names.length === 0
      ? 'current failing check-name evidence unavailable'
      : `failing checks: ${names.join(', ')}`;
  return `merge.checks-retry-exhausted: bounded check repair exhausted; ${detail}`;
}
