import type { ActivityOutcome } from '../../activities/index.js';
import type { EventDraft } from '../../kernel/index.js';
import type { CompiledOutcomeRoute, CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

interface TransitionInput {
  readonly outcome: ActivityOutcome;
  readonly occurredAt: string;
  readonly causationId: string;
}

export function finishRoute(
  events: EventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: TransitionInput,
  route: CompiledOutcomeRoute,
): void {
  if (route.then === 'done') {
    events.push(stateDraft(state, input, 'instance-completed', {}, events.length + 1));
    return;
  }
  if (route.then === 'await-human') {
    events.push(
      stateDraft(
        state,
        input,
        'signal-wait-started',
        { signalKind: input.outcome.kind },
        events.length + 1,
      ),
    );
    return;
  }
  const count = (state.repeatCounts[route.id] ?? 0) + 1;
  if (route.repeat !== undefined) {
    if (count > route.repeat.max) {
      events.push(
        stateDraft(
          state,
          input,
          'instance-blocked',
          { reason: `repeat.max exceeded for ${route.id}` },
          events.length + 1,
        ),
      );
      return;
    }
    events.push(
      stateDraft(state, input, 'repeat-counted', { routeId: route.id, count }, events.length + 1),
    );
  }
  const stage = definition.stages[route.then]!;
  events.push(
    stateDraft(state, input, 'stage-entered', { stage: route.then }, events.length + 1),
    stateDraft(
      state,
      input,
      'activity-requested',
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
      }),
      events.length + 2,
    ),
  );
}
