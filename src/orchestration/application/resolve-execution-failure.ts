import { EventSourceKind, type CommandContext } from '@atolis-hq/eventing';
import { ActivityOutcomeKind, type ActivationId } from '../../activities/index.js';
import { ExecutionFailureCode, isAmbiguityResolutionBlockReason } from '../../execution/index.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { workflowEventData } from '../domain/decision-events.js';
import type { AcceptActivityOutcome } from './accept-activity-outcome.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

export interface ExecutionFailureInput {
  readonly activationId: ActivationId;
  readonly runId: string;
  readonly reason: string;
  readonly failureKind?: ExecutionFailureCode;
}

export async function resolveExecutionFailure(
  repository: OrchestrationRepository,
  acceptOutcome: AcceptActivityOutcome['execute'],
  id: WorkflowInstanceId,
  input: ExecutionFailureInput,
  context: CommandContext,
) {
  if (input.failureKind === ExecutionFailureCode.Interrupted)
    return acceptOutcome(
      {
        workflowInstanceId: id,
        activationId: input.activationId,
        outcome: { kind: ActivityOutcomeKind.Failed },
      },
      context,
    );
  const loaded = await repository.load(id);
  if (
    loaded.view === null ||
    (loaded.view.status === WorkflowStatus.Blocked &&
      !isAmbiguityResolutionBlock(loaded.view.blockReason)) ||
    loaded.view.pendingActivation?.activationId !== input.activationId ||
    loaded.view.acceptedOutcomes.includes(input.activationId)
  )
    return loaded.view;
  await repository.append(id, loaded.sequence, [
    workflowEventData({
      eventId: `${context.commandId}:${OrchestrationEventType.ActivityExecutionFailed}`,
      eventType: OrchestrationEventType.ActivityExecutionFailed,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
      payload: { activationId: input.activationId, runId: input.runId, reason: input.reason },
    }),
    workflowEventData({
      eventId: `${context.commandId}:${OrchestrationEventType.InstanceBlocked}`,
      eventType: OrchestrationEventType.InstanceBlocked,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
      payload: { reason: input.reason },
    }),
  ]);
  return (await repository.load(id)).view;
}

export function isAmbiguityResolutionBlock(reason: string | undefined): boolean {
  return isAmbiguityResolutionBlockReason(reason);
}
