import type { EventEnvelope } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import { isRecoveryBlockReason } from '../../execution/index.js';
import { WorkflowStatus, type WorkflowInstanceView } from '../../orchestration/index.js';
import {
  selectControlEvent,
  type ControlEventPayloads,
  type ControlEventType,
} from '../contracts/events.js';
import type { TriggerView } from './trigger-projection.js';

type FinishedStatus =
  ControlEventPayloads[typeof ControlEventType.TriggerInvocationFinished]['status'];

export function hasActiveInvocation(view: TriggerView, coordinationKey: string): boolean {
  return view.invocations.some(
    (invocation) =>
      invocation.claim.coordinationKey === coordinationKey && invocation.result === undefined,
  );
}

/** Events caused by this scope's own invocations must not re-trigger it. */
export async function isOwnScopeSource(
  view: TriggerView,
  scope: { readonly triggerId: string; readonly coordinationKey: string },
  event: EventEnvelope | undefined,
  resolve: {
    readonly keyOf: (triggerId: string) => string | undefined;
    readonly sourceWorkItem: (event: EventEnvelope) => Promise<string | null>;
    readonly invocationScope: (workItemId: string) => Promise<string | null>;
  },
): Promise<boolean> {
  if (event === undefined) return false;
  const control = selectControlEvent(event);
  if (control !== null && 'triggerId' in control.event.payload) {
    const id = control.event.payload.triggerId;
    if (
      id === scope.triggerId ||
      ('coordinationKey' in control.event.payload &&
        control.event.payload.coordinationKey === scope.coordinationKey) ||
      resolve.keyOf(id) === scope.coordinationKey ||
      view.invocations.some(
        (invocation) =>
          invocation.claim.triggerId === id &&
          invocation.claim.coordinationKey === scope.coordinationKey,
      )
    )
      return true;
  }
  const sourceItem = await resolve.sourceWorkItem(event);
  return (
    sourceItem !== null && (await resolve.invocationScope(sourceItem)) === scope.coordinationKey
  );
}

/** Blocking or a failed outcome with no retry wait left ends automatic workflow progress. */
export function exhaustedFailures(instance: WorkflowInstanceView): boolean {
  if (isRecoveryBlockReason(instance.blockReason)) return false;
  const failed = instance.lastOutcome?.kind === ActivityOutcomeKind.Failed;
  return (
    instance.status === WorkflowStatus.Blocked ||
    (failed && instance.status === WorkflowStatus.Completed) ||
    (failed &&
      instance.status === WorkflowStatus.Waiting &&
      instance.waitingFor?.signalKind === ActivityOutcomeKind.Failed)
  );
}

export function finishedStatus(instance: WorkflowInstanceView): FinishedStatus | undefined {
  if (instance.status === WorkflowStatus.Completed || instance.status === WorkflowStatus.Superseded)
    return instance.status;
  return undefined;
}
