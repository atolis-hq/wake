import {
  type CommandContext,
  type EventJournal,
  WrongExpectedSequenceError,
  entityRef,
} from '../../kernel/index.js';
import type {
  ChildCoordinationMetadata,
  GroupBudgetExhaustedPayload,
} from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { coordinationDraft } from '../domain/coordination-events.js';

export class GroupBudgetRecorder {
  constructor(private readonly journal: EventJournal) {}

  async record(
    parent: WorkflowInstanceView,
    metadata: ChildCoordinationMetadata,
    maxPerGroup: number,
    context: CommandContext,
  ): Promise<void> {
    const stream = entityRef('workflow-instance', parent.workflowInstanceId);
    const payload: GroupBudgetExhaustedPayload = { ...metadata, maxPerGroup };
    for (;;) {
      const events = await this.journal.readStream(stream);
      if (
        events.some(
          (event) =>
            event.eventType === 'orchestration.group-budget-exhausted' &&
            isRequest(event.payload, metadata.requestId),
        )
      )
        return;
      try {
        await this.journal.append(stream, events.length, [
          coordinationDraft(
            {
              workflowInstanceId: parent.workflowInstanceId,
              eventIdPrefix: context.commandId,
              occurredAt: context.occurredAt,
              correlationId: parent.orchestrationGroupId,
              causationId: context.commandId,
            },
            'orchestration.group-budget-exhausted',
            payload,
            1,
          ),
        ]);
        return;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }
}

function isRequest(payload: unknown, requestId: string): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as Record<string, unknown>).requestId === requestId
  );
}
