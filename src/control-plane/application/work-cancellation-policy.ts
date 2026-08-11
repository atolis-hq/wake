import { ExecutionCancellationReason, type ActiveRunCancellation } from '../../execution/index.js';
import {
  EventActorKind,
  correlationId,
  type Clock,
  type CommandContext,
  type IdGenerator,
} from '../../kernel/index.js';
import type { WorkflowInstanceView } from '../../orchestration/index.js';
import type { WorkItemId, WorkItemView } from '../../work/index.js';
import { ControlStreamKind } from '../contracts/streams.js';

interface WorkPort {
  close(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  cancel(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
}

interface OrchestrationPort {
  listAll(): Promise<readonly WorkflowInstanceView[]>;
  block(
    workflowInstanceId: string,
    reason: string,
    context: CommandContext,
  ): Promise<WorkflowInstanceView | null>;
}

export interface WorkConclusionPolicy {
  cancelWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
  closeWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView>;
}

/** Applies a Work conclusion (close or cancel) consistently to active workflows and their Runs. */
export function createWorkCancellationPolicy(
  work: WorkPort,
  orchestration: OrchestrationPort,
  execution: ActiveRunCancellation,
  clock: Clock,
  ids: IdGenerator,
): WorkConclusionPolicy {
  async function conclude(
    workItemId: WorkItemId,
    reason: string,
    workAction: (context: CommandContext) => Promise<WorkItemView>,
    executionReason: ExecutionCancellationReason,
    blockReasonPrefix: string,
  ): Promise<WorkItemView> {
    const context = commandContext(clock, ids, workItemId);
    const concluded = await workAction(context);
    const workflows = (await orchestration.listAll()).filter(
      (workflow) => workflow.workItemId === workItemId,
    );
    await execution.cancelActive(
      workflows.map((workflow) => workflow.workflowInstanceId),
      executionReason,
    );
    for (const workflow of workflows)
      await orchestration.block(
        workflow.workflowInstanceId,
        `${blockReasonPrefix}: ${reason}`,
        context,
      );
    return concluded;
  }

  return {
    cancelWork(workItemId, reason) {
      return conclude(
        workItemId,
        reason,
        (context) => work.cancel(workItemId, reason, context),
        ExecutionCancellationReason.WorkCancelled,
        'work cancelled',
      );
    },
    closeWork(workItemId, reason) {
      return conclude(
        workItemId,
        reason,
        (context) => work.close(workItemId, reason, context),
        ExecutionCancellationReason.WorkClosed,
        'work closed',
      );
    },
  };
}

function commandContext(clock: Clock, ids: IdGenerator, cause: string): CommandContext {
  return {
    commandId: ids.next('command'),
    correlationId: correlationId(cause),
    occurredAt: clock.now().toISOString(),
    actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
  };
}
