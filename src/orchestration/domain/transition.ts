import type { ActivityOutcome } from '../../activities/index.js';
import type {
  CompiledOutcomeRoute,
  CompiledWorkflow,
  TransitionTarget,
} from '../contracts/config.js';
import type { WorkflowOrchestrationEventData } from '../contracts/events.js';
import {
  OrchestrationEventType,
  ResourceTransitionSignal,
  WatchGateVerdictSignal,
} from '../contracts/events.js';
import type { StageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind, TransitionTargetKind } from '../contracts/vocabulary.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

interface TransitionInput {
  readonly outcome: ActivityOutcome;
  readonly occurredAt: string;
  readonly causationId: string;
}

interface DecisionContext {
  readonly occurredAt: string;
  readonly causationId: string;
}

// Route completion combines the mutually exclusive wait, await, and target policies.
// eslint-disable-next-line complexity, max-lines-per-function
export function finishRoute(
  events: WorkflowOrchestrationEventData[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: TransitionInput,
  route: CompiledOutcomeRoute,
): void {
  if (route.watchGates !== undefined || route.resourceTransitions !== undefined) {
    const gate = route.watchGates?.[0];
    events.push(
      stateDraft(
        state,
        input,
        {
          eventType: OrchestrationEventType.SignalWaitStarted,
          payload: {
            signalKind: gate === undefined ? ResourceTransitionSignal : WatchGateVerdictSignal,
            ...(gate === undefined
              ? {}
              : {
                  from: Object.freeze([
                    { kind: ApprovalAuthorityKind.Watch, watch: gate.watch },
                    { kind: ApprovalAuthorityKind.Human },
                  ]),
                }),
            resume: route.target,
            ...(gate === undefined ? {} : { onRejectResume: gate.onRejectTarget }),
            ...(route.resourceTransitions === undefined
              ? {}
              : { resourceTransitions: route.resourceTransitions }),
          },
        },
        events.length + 1,
      ),
    );
    return;
  }
  if (route.await !== undefined) {
    events.push(
      stateDraft(
        state,
        input,
        {
          eventType: OrchestrationEventType.SignalWaitStarted,
          payload: {
            signalKind: route.await.signal,
            from: route.await.from,
            resume: route.await.resume,
            onRejectResume: route.reentryTarget,
          },
        },
        events.length + 1,
      ),
    );
    return;
  }
  if (route.target.kind !== TransitionTargetKind.Stage) {
    resumeToTarget(events, definition, state, input, route.target);
    return;
  }
  const count = (state.repeatCounts[route.id] ?? 0) + 1;
  if (route.repeat !== undefined) {
    if (count > route.repeat.max) {
      events.push(
        stateDraft(
          state,
          input,
          {
            eventType: OrchestrationEventType.InstanceBlocked,
            payload: { reason: `repeat.max exceeded for ${route.id}` },
          },
          events.length + 1,
        ),
      );
      return;
    }
    events.push(
      stateDraft(
        state,
        input,
        {
          eventType: OrchestrationEventType.RepeatCounted,
          payload: { routeId: route.id, count },
        },
        events.length + 1,
      ),
    );
  }
  pushStageEntry(events, definition, state, input, route.target.stage);
}

function pushStageEntry(
  events: WorkflowOrchestrationEventData[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: DecisionContext,
  stageName: StageName,
): void {
  const stage = definition.stages[stageName]!;
  events.push(
    stateDraft(
      state,
      input,
      { eventType: OrchestrationEventType.StageEntered, payload: { stage: stageName } },
      events.length + 1,
    ),
    stateDraft(
      state,
      input,
      {
        eventType: OrchestrationEventType.ActivityRequested,
        payload: activation(
          state.workflowInstanceId,
          nextOrdinal(state),
          stage.activity,
          stage.with,
          {
            execution: stage.execution,
            stage: stageName,
          },
        ),
      },
      events.length + 2,
    ),
  );
}

// Shared by a route with no gate (target reached directly) and a resumed wait
// (target reached after an accepted signal); neither carries repeat counting.
export function resumeToTarget(
  events: WorkflowOrchestrationEventData[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: DecisionContext,
  target: TransitionTarget,
): void {
  if (target.kind === TransitionTargetKind.Complete) {
    events.push(
      stateDraft(
        state,
        input,
        { eventType: OrchestrationEventType.InstanceCompleted, payload: {} },
        events.length + 1,
      ),
    );
    return;
  }
  if (target.kind === TransitionTargetKind.AwaitSignal) {
    events.push(
      stateDraft(
        state,
        input,
        {
          eventType: OrchestrationEventType.SignalWaitStarted,
          payload: { signalKind: target.signal },
        },
        events.length + 1,
      ),
    );
    return;
  }
  if (target.kind === TransitionTargetKind.ResourceTransitionWait)
    throw new Error('resource-transition wait must be resumed by a resource transition');
  pushStageEntry(events, definition, state, input, target.stage);
}
