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

/** Applies a Work cancellation consistently to active workflows and their Runs. */
export function createWorkCancellationPolicy(
  work: WorkPort,
  orchestration: OrchestrationPort,
  execution: ActiveRunCancellation,
  clock: Clock,
  ids: IdGenerator,
) {
  return {
    async cancelWork(workItemId: WorkItemId, reason: string): Promise<WorkItemView> {
      const context = commandContext(clock, ids, workItemId);
      const cancelled = await work.cancel(workItemId, reason, context);
      const workflows = (await orchestration.listAll()).filter(
        (workflow) => workflow.workItemId === workItemId,
      );
      await execution.cancelActive(
        workflows.map((workflow) => workflow.workflowInstanceId),
        ExecutionCancellationReason.WorkCancelled,
      );
      for (const workflow of workflows)
        await orchestration.block(
          workflow.workflowInstanceId,
          `work cancelled: ${reason}`,
          context,
        );
      return cancelled;
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
