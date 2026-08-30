import { ActivityEventType, selectActivityEvent } from '../../activities/index.js';
import type { CommandContext } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { CompiledResourceTransition, TransitionTarget } from '../contracts/config.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { acceptSignal as decideSignal } from '../domain/interpreter.js';
import { appendWithIntentRecovery } from './durable-append.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';
import { resolveTriggerWorkflowInstanceId } from './trigger-workflow-instance.js';

type PersistedEvent = Parameters<typeof selectActivityEvent>[0];

export interface ResourceTransitionMatch {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly workItemId: WorkItemId;
  readonly transitions: readonly CompiledResourceTransition[];
}

// Generic: no resource-kind knowledge lives here. A `signal-wait-started`
// trigger on the instance's own stream returns every declared transition
// unfiltered, so the reactor's evidence policy can check prior journal
// history for a fact that arrived before the wait began. Any other event
// is matched against each instance's declared predicates directly.
export async function matchResourceTransitions(
  loaded: readonly { readonly view: WorkflowInstanceView }[],
  event: PersistedEvent,
): Promise<readonly ResourceTransitionMatch[]> {
  const waitStart = await resolveTriggerWorkflowInstanceId(event, undefined);
  return loaded.flatMap(({ view }) => {
    if (view.status !== WorkflowStatus.Waiting) return [];
    const declared = view.waitingFor?.resourceTransitions;
    if (declared === undefined) return [];
    if (waitStart !== undefined)
      return view.workflowInstanceId === waitStart
        ? [
            {
              workflowInstanceId: view.workflowInstanceId,
              workItemId: view.workItemId,
              transitions: declared,
            },
          ]
        : [];
    const transitions = declared.filter((transition) => matchesFact(transition, event));
    return transitions.length === 0
      ? []
      : [{ workflowInstanceId: view.workflowInstanceId, workItemId: view.workItemId, transitions }];
  });
}

// Compares the declared predicate key-wise against the event payload.
function matchesFact(transition: CompiledResourceTransition, event: PersistedEvent): boolean {
  const activity = selectActivityEvent(event);
  if (activity === null || transition.event !== activity.event.eventType) return false;
  if (transition.where === undefined) return true;
  if (activity.event.eventType === ActivityEventType.PrStateChanged && 'state' in transition.where)
    return activity.event.payload.state === transition.where.state;
  if (
    activity.event.eventType === ActivityEventType.PrChecksChanged &&
    'checks' in transition.where
  )
    return activity.event.payload.checks === transition.where.checks;
  return false;
}

// Applies a transition the reactor's evidence policy already confirmed. The
// route target comes from the matched transition, not the wait's own
// resume, so the decision is taken against the transition's destination.
// Once applied the instance leaves Waiting, so a repeated call with the
// same evidence is a no-op — there is no separate consumed-fact guard.
export async function acceptResourceTransition(
  repository: OrchestrationRepository,
  workflows: StartWorkflow,
  id: WorkflowInstanceId,
  target: TransitionTarget,
  evidenceId: string,
  context: CommandContext,
): Promise<WorkflowInstanceView | null> {
  const loaded = await repository.load(id);
  if (loaded.view === null || loaded.view.waitingFor === undefined) return loaded.view;
  const definition = await workflows.definitionForOperation(loaded.view, loaded.sequence, context);
  if (definition === null) return loaded.view;
  const decision = decideSignal(
    definition,
    { ...loaded.view, waitingFor: { ...loaded.view.waitingFor, resume: target } },
    {
      signal: {
        kind: loaded.view.waitingFor.signalKind,
        actorId: 'resource-transition',
        actorDecision: { authorized: true, evidenceId },
        providerEventId: evidenceId,
      },
      occurredAt: context.occurredAt,
      causationId: `${context.commandId}:${evidenceId}`,
      consent: true,
    },
  );
  if (decision.kind === 'append') {
    const recovered = await appendWithIntentRecovery({
      append: async () => {
        await repository.append(id, loaded.sequence, decision.events);
      },
      load: () => repository.load(id),
      alreadyApplied: (reloaded) =>
        reloaded.view !== null &&
        (reloaded.view.acceptedSignalIds.includes(evidenceId) ||
          reloaded.view.waitingFor === undefined),
    });
    if (recovered !== undefined) return recovered.view;
  }
  return (await repository.load(id)).view;
}
