import type { selectActivityEvent } from '../../activities/index.js';
import type { CommandContext } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { CompiledResourceTransition, TransitionTarget } from '../contracts/config.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import { isWorkflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { acceptSignal as decideSignal } from '../domain/interpreter.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import type { StartWorkflow } from './start-workflow.js';

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
export function matchResourceTransitions(
  loaded: readonly { readonly view: WorkflowInstanceView }[],
  event: PersistedEvent,
): readonly ResourceTransitionMatch[] {
  const waitStart =
    event.eventType === OrchestrationEventType.SignalWaitStarted &&
    isWorkflowInstanceStream(event.stream)
      ? event.stream.id
      : undefined;
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
  if (transition.event !== event.eventType) return false;
  if (transition.where === undefined) return true;
  const payload = event.payload as Record<string, unknown>;
  return Object.entries(transition.where).every(([key, value]) => payload[key] === value);
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
    try {
      await repository.append(id, loaded.sequence, decision.events);
    } catch (error) {
      const reloaded = await repository.load(id);
      if (
        reloaded.view !== null &&
        (reloaded.view.acceptedSignalIds.includes(evidenceId) ||
          reloaded.view.waitingFor === undefined)
      )
        return reloaded.view;
      throw error;
    }
  }
  return (await repository.load(id)).view;
}
