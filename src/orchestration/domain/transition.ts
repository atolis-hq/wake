import type { ActivityOutcome } from '../../activities/index.js';
import type {
  CompiledOutcomeRoute,
  CompiledWorkflow,
  TransitionTarget,
} from '../contracts/config.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import {
  EventTransitionSignal,
  OrchestrationEventType,
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
// eslint-disable-next-line complexity
export function finishRoute(
  events: WorkflowOrchestrationEventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: TransitionInput,
  route: CompiledOutcomeRoute,
): void {
  if (route.watchGates !== undefined || route.eventTransitions !== undefined) {
    const gate = route.watchGates?.[0];
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.SignalWaitStarted,
        {
          signalKind: gate === undefined ? EventTransitionSignal : WatchGateVerdictSignal,
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
          ...(route.eventTransitions === undefined
            ? {}
            : { eventTransitions: route.eventTransitions }),
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
        OrchestrationEventType.SignalWaitStarted,
        { signalKind: route.await.signal, from: route.await.from, resume: route.await.resume },
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
          OrchestrationEventType.InstanceBlocked,
          { reason: `repeat.max exceeded for ${route.id}` },
          events.length + 1,
        ),
      );
      return;
    }
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.RepeatCounted,
        { routeId: route.id, count },
        events.length + 1,
      ),
    );
  }
  pushStageEntry(events, definition, state, input, route.target.stage);
}

function pushStageEntry(
  events: WorkflowOrchestrationEventDraft[],
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
      OrchestrationEventType.StageEntered,
      { stage: stageName },
      events.length + 1,
    ),
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
        stage: stageName,
      }),
      events.length + 2,
    ),
  );
}

// Shared by a route with no gate (target reached directly) and a resumed wait
// (target reached after an accepted signal); neither carries repeat counting.
export function resumeToTarget(
  events: WorkflowOrchestrationEventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: DecisionContext,
  target: TransitionTarget,
): void {
  if (target.kind === TransitionTargetKind.Complete) {
    events.push(
      stateDraft(state, input, OrchestrationEventType.InstanceCompleted, {}, events.length + 1),
    );
    return;
  }
  if (target.kind === TransitionTargetKind.AwaitSignal) {
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.SignalWaitStarted,
        { signalKind: target.signal },
        events.length + 1,
      ),
    );
    return;
  }
  pushStageEntry(events, definition, state, input, target.stage);
}
