import { WrongExpectedSequenceError, type CommandContext } from '@atolis-hq/eventing';
import { isDeepStrictEqual } from 'node:util';
import type { ActivityName } from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import type { DelegationMessages } from '../contracts/delegation-ports.js';
import type { DelegationInputs, DelegationReservation } from '../contracts/delegation.js';
import type { WorkflowOrchestrationEvent } from '../contracts/events.js';
import { OrchestrationEventType as Event } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { activation } from '../domain/decision-events.js';
import { delegationDraft } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';

export interface PrerequisiteRefreshDependencies {
  readonly workflows: StartWorkflow;
  readonly messages?: DelegationMessages | undefined;
  readonly supportsAttention?: ((activity: ActivityName) => boolean) | undefined;
  readonly childRunsEnded?: ((id: string) => Promise<boolean>) | undefined;
}

/** Re-enter the child's own branch activity; the agent assesses and performs all Git repairs. */
export async function refreshPrerequisites(
  repository: OrchestrationRepository,
  dependencies: PrerequisiteRefreshDependencies,
  child: DelegationReservation['children'][number],
  inputs: DelegationInputs,
  context: CommandContext,
): Promise<void> {
  const loaded = await repository.loadRequired(child.workflowInstanceId);
  const view = loaded.view;
  if (await prerequisiteRefreshInapplicability(view, dependencies)) return;
  const history = await repository.history(child.workflowInstanceId);
  if (
    history.events.some(
      ({ event }) =>
        event.eventType === Event.DelegationInputsRefreshed &&
        isDeepStrictEqual(event.payload, inputs),
    )
  )
    return;
  const stageName = branchStage(history.events);
  const definition = await dependencies.workflows.definitionFor(view);
  const stage = definition.stages[stageName]!;
  if (!dependencies.supportsAttention?.(stage.activity) || dependencies.messages === undefined)
    throw new Error('Prerequisite refresh requires an agent activity and conversation adapter');
  const request = activation(
    view.workflowInstanceId,
    history.events.reduce(
      (ordinal, { event }) =>
        event.eventType === Event.ActivityRequested
          ? Math.max(ordinal, event.payload.ordinal + 1)
          : ordinal,
      1,
    ),
    stage.activity,
    stage.with ?? {},
    {
      execution: stage.execution,
      stage: stageName,
      sessionPolicy: 'fresh',
    },
  );
  const key = `refresh:${request.activationId}`;
  await dependencies.messages.post(
    {
      workItemId: child.workItemId,
      entryId: key,
      authorId: 'delegation-prerequisites',
      body: prerequisiteRefreshPrompt(inputs),
    },
    context,
  );
  try {
    await repository.append(child.workflowInstanceId, loaded.sequence, [
      delegationDraft(
        context,
        key,
        { eventType: Event.DelegationInputsRefreshed, payload: inputs },
        child.workflowInstanceId,
      ),
      delegationDraft(
        context,
        key + ':stage',
        { eventType: Event.StageEntered, payload: { stage: stageName } },
        child.workflowInstanceId,
      ),
      delegationDraft(
        context,
        key + ':activity',
        { eventType: Event.ActivityRequested, payload: request },
        child.workflowInstanceId,
      ),
    ]);
  } catch (error) {
    if (!(error instanceof WrongExpectedSequenceError)) throw error;
  }
}

export function prerequisiteRefreshPrompt(inputs: DelegationInputs): string {
  return `An upstream review revision changed your consumed inputs. Assess and refresh your existing work onto the exact verified inputs below. You own all Git operations, including rebase, push and PR updates. Preserve your assignment and run its checks again. Report BLOCKED if you cannot safely refresh. Completion requires a new successful branch run and the configured review gates.\n\n${JSON.stringify(inputs, null, 2)}`;
}

export async function prerequisiteRefreshInapplicability(
  view: WorkflowInstanceView,
  dependencies: PrerequisiteRefreshDependencies,
) {
  if (view.status === WorkflowStatus.Superseded) return 'Child workflow is superseded';
  if (view.status === WorkflowStatus.Blocked) return 'Child workflow is blocked';
  if (view.delegationFence !== undefined) return 'Child has an unresolved delegation cohort';
  if (dependencies.childRunsEnded === undefined) return 'Child Run verification is unavailable';
  if (!(await dependencies.childRunsEnded(view.workflowInstanceId)))
    return 'Child has unresolved Runs';
  return undefined;
}

function branchStage(events: readonly WorkflowOrchestrationEvent[]) {
  const first = events.find(
    ({ event }) =>
      event.eventType === Event.ActivityRequested &&
      event.payload.execution?.workspace === WorkspaceMode.Branch,
  )?.event;
  if (first?.eventType !== Event.ActivityRequested || first.payload.stage === undefined)
    throw new Error('No branch activity available for prerequisite refresh');
  return first.payload.stage;
}
