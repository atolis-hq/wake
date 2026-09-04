import type { CommandContext } from '@atolis-hq/eventing';
import type { OrchestrationSignal } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';

interface SignalOrchestrationPort {
  listWaiting(signalKind?: string): Promise<readonly (WorkflowInstanceView | null)[]>;
  acceptSignal(
    workflowInstanceId: string,
    signal: OrchestrationSignal,
    context: CommandContext,
  ): Promise<WorkflowInstanceView>;
}

export function createSignalReactor(orchestration: SignalOrchestrationPort) {
  return {
    async accept(signal: OrchestrationSignal, context: CommandContext) {
      const waiting = await orchestration.listWaiting(signal.kind);
      const accepted: WorkflowInstanceView[] = [];
      for (const instance of waiting) {
        if (instance === null) continue;
        const before = instance.acceptedSignalIds.length;
        const after = await orchestration.acceptSignal(
          instance.workflowInstanceId,
          signal,
          context,
        );
        if (after.acceptedSignalIds.length > before) accepted.push(after);
      }
      return accepted;
    },
  };
}
