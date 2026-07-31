import {
  type CommandContext,
  type EventJournal,
  WrongExpectedSequenceError,
} from '../../kernel/index.js';
import { workflowInstanceId } from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';
import type {
  ChildCoordinationMetadata,
  GroupBudgetExhaustedPayload,
} from '../contracts/events.js';
import { OrchestrationEventType, selectOrchestrationEvent } from '../contracts/events.js';
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
    const stream = workflowInstanceStream(workflowInstanceId(parent.workflowInstanceId));
    const payload: GroupBudgetExhaustedPayload = { ...metadata, maxPerGroup };
    for (;;) {
      const events = await this.journal.readStream(stream);
      if (
        events.some((event) => {
          const owned = selectOrchestrationEvent(event);
          return (
            owned?.eventType === OrchestrationEventType.GroupBudgetExhausted &&
            owned.payload.requestId === metadata.requestId
          );
        })
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
            OrchestrationEventType.GroupBudgetExhausted,
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
