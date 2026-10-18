import { correlationId, EventActorKind, type CommandContext } from '@atolis-hq/eventing';
import { workflowInstanceId } from '../../orchestration/index.js';
import { workItemId } from '../../work/index.js';
import { ControlEventType } from '../contracts/events.js';
import type { TriggerFactInput } from './trigger-facts.js';
import type { TriggerInvocationView } from './trigger-projection.js';
import { exhaustedFailures, finishedStatus } from './trigger-rules.js';
import { ensureTriggerWorkflow, type TriggerWorkflowPorts } from './trigger-workflow.js';

interface TriggerRecoveryPorts extends TriggerWorkflowPorts {
  readonly emit: (
    input: TriggerFactInput,
    context: CommandContext,
    eventId: string,
  ) => Promise<void>;
}

/** Blocked invocations remain recoverable through operator retry or clarification. */
export async function recoverTriggerInvocation(
  dependencies: TriggerRecoveryPorts,
  invocation: TriggerInvocationView,
  context: CommandContext,
): Promise<void> {
  const claim = invocation.claim;
  const workflow = workflowInstanceId(claim.workflowInstanceId);
  const invocationContext: CommandContext = {
    commandId: `${workflow}:create`,
    correlationId: correlationId(workflow),
    occurredAt: invocation.claimedAt,
    actor: { kind: EventActorKind.System, id: claim.triggerId },
  };
  const instance = await ensureTriggerWorkflow(dependencies, claim, invocationContext);
  if (invocation.startedAt === undefined) {
    await dependencies.emit(
      {
        eventType: ControlEventType.TriggerInvocationStarted,
        payload: {
          triggerId: claim.triggerId,
          coordinationKey: claim.coordinationKey,
          source: claim.source,
          workItemId: workItemId(claim.workItemId),
          workflowInstanceId: workflow,
          workflowName: claim.workflowName,
        },
      },
      invocationContext,
      `${workflow}:${ControlEventType.TriggerInvocationStarted}`,
    );
  }
  if (instance === null) return;
  if (
    exhaustedFailures(instance) &&
    invocation.failureOutcomeCount !== instance.acceptedOutcomes.length
  ) {
    // Workflow retries remain explicit; pause suppresses subsequent automatic sources.
    await dependencies.emit(
      {
        eventType: ControlEventType.TriggerPaused,
        payload: {
          triggerId: claim.triggerId,
          coordinationKey: claim.coordinationKey,
          workflowInstanceId: claim.workflowInstanceId,
          outcomeCount: instance.acceptedOutcomes.length,
          reason: instance.blockReason ?? 'Invocation exhausted automatic failure retries',
        },
      },
      context,
      `${workflow}:pause:${instance.acceptedOutcomes.length}`,
    );
  }
  const status = finishedStatus(instance);
  if (
    status === undefined ||
    (await dependencies.orchestration.hasLiveDelegatedWork?.(workItemId(claim.workItemId)))
  )
    return;
  await dependencies.emit(
    {
      eventType: ControlEventType.TriggerInvocationFinished,
      payload: {
        triggerId: claim.triggerId,
        coordinationKey: claim.coordinationKey,
        workItemId: claim.workItemId,
        workflowInstanceId: workflow,
        status,
        ...(instance.blockReason === undefined ? {} : { reason: instance.blockReason }),
      },
    },
    context,
    `${workflow}:finished`,
  );
}
