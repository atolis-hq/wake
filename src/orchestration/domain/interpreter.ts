import { ActivityOutcomeKind } from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  acceptOutcomeDraft,
  isPendingOutcome,
  requestFollowOn,
  type AcceptActivityOutcome,
  type OrchestrationDecision,
} from './activation-policy.js';
import { stateDraft } from './decision-events.js';
import { mayRetry, requestRetry } from './retry-policy.js';
import { acceptWaitingOutcome } from './signal-policy.js';
import { finishSupplemental, requestNextSupplemental } from './supplemental-policy.js';
import { finishRoute } from './transition.js';

export { startInstance } from './activation-policy.js';

export type {
  AcceptActivityOutcome,
  DecisionContext,
  OrchestrationDecision,
  QueueSupplementalActivity,
  StartInstanceInput,
} from './activation-policy.js';

export { acceptSignal, waitForSignal } from './signal-policy.js';

export type { AcceptSignal } from './signal-policy.js';

export { requestSupplementalActivity } from './supplemental-policy.js';

export type { SupplementalActivityRequest } from './supplemental-policy.js';

export {
  isChangesResumeEligible,
  isOperatorRetryEligible,
  requestChangesResume,
  requestOperatorRetry,
  selectOperatorRetryTarget,
} from './operator-retry-policy.js';

export type { OperatorRetryRequest } from './operator-retry-policy.js';

export function acceptActivityOutcome(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): OrchestrationDecision {
  if (!isPendingOutcome(state, input))
    return { kind: 'ignored', reason: 'outcome is not for the pending activation' };
  if (input.outcome.kind === ActivityOutcomeKind.Waiting) return acceptWaitingOutcome(state, input);

  const events: WorkflowOrchestrationEventDraft[] = [acceptOutcomeDraft(state, input)];
  const pending = state.pendingActivation!;
  if (pending.supplemental === true) {
    finishSupplemental(events, definition, state, input);
    return { kind: 'append', events };
  }

  const route = definition.stages[stageName(state.currentStage)]?.on[input.outcome.kind];
  if (route === undefined) {
    // The outcome still durably happened even though this stage never
    // declared how to route it — recording it (not just blocking) is what
    // keeps the activation resolved, so nothing can later mistake it for
    // still being open and resolve it via an unrelated signal.
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.InstanceBlocked,
        { reason: `unconfigured outcome ${input.outcome.kind}` },
        events.length + 1,
      ),
    );
    return { kind: 'append', events };
  }
  if (input.outcome.kind !== ActivityOutcomeKind.Done) {
    if (mayRetry(route, state, input.outcome)) requestRetry(events, definition, state, input);
    else finishRoute(events, definition, state, input, route);
    return { kind: 'append', events };
  }

  if (state.supplementalQueue.length > 0) {
    requestNextSupplemental(events, state, input);
    return { kind: 'append', events };
  }
  if (requestFollowOn(events, state, input, route.activities ?? []))
    return { kind: 'append', events };
  finishRoute(events, definition, state, input, route);
  return { kind: 'append', events };
}
