import {
  createEventDraft,
  EventSourceKind,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import type { ChildWorkflowRequest } from '../contracts/events.js';
import { OrchestrationEventType, type OrchestrationGroupEvent } from '../contracts/events.js';
import {
  isOrchestrationGroupStream,
  primaryOrchestrationGroupStream,
  type ChildOrchestrationGroupStreamRef,
} from '../contracts/streams.js';
import { claimWithCasRetry } from './durable-append.js';

export class CoordinationClaims {
  constructor(private readonly journal: EventJournal) {}

  async claimPrimary(
    workItemId: WorkItemId,
    workflowInstanceId: string,
    context: CommandContext,
  ): Promise<void> {
    const stream = primaryOrchestrationGroupStream(workItemId);
    await claimWithCasRetry({
      read: () => this.journal.readStream(stream),
      decode: groupEvents,
      alreadyClaimed: (events) => {
        const owner = primaryOwner(events);
        if (owner === undefined) return false;
        if (owner === workflowInstanceId) return true;
        throw new Error(`WorkItem already has an active primary workflow owned by ${owner}`);
      },
      append: async (sequence) => {
        await this.journal.append(stream, sequence, [
          createEventDraft({
            eventId: `${context.commandId}:${OrchestrationEventType.PrimaryClaimed}:${workItemId}`,
            eventType: OrchestrationEventType.PrimaryClaimed,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
            stream,
            payload: { workItemId, workflowInstanceId },
          }),
        ]);
      },
    });
  }

  async primaryWorkflowInstanceId(workItemId: WorkItemId): Promise<string | undefined> {
    return primaryOwner(
      groupEvents(await this.journal.readStream(primaryOrchestrationGroupStream(workItemId))),
    );
  }

  async claimWithinBudget(
    stream: ChildOrchestrationGroupStreamRef,
    request: ChildWorkflowRequest & { readonly maxPerGroup: number },
    context: CommandContext,
  ): Promise<boolean> {
    const claimed = await claimWithCasRetry({
      read: () => this.journal.readStream(stream),
      decode: groupEvents,
      alreadyClaimed: (events) => claimedRequestIds(events).has(request.requestId),
      canAppend: (events) => events.length < request.maxPerGroup,
      append: async (sequence) => {
        await this.journal.append(stream, sequence, [
          createEventDraft({
            eventId: `${context.commandId}:${OrchestrationEventType.GroupClaimed}:${request.requestId}`,
            eventType: OrchestrationEventType.GroupClaimed,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
            stream,
            payload: { key: stream.id, requestId: request.requestId },
          }),
        ]);
      },
    });
    return claimed;
  }
}

function primaryOwner(events: readonly OrchestrationGroupEvent[]): string | undefined {
  for (const event of events) {
    switch (event.eventType) {
      case OrchestrationEventType.PrimaryClaimed:
        return event.payload.workflowInstanceId;
      case OrchestrationEventType.GroupClaimed:
        break;
      default:
        assertNever(event);
    }
  }
  return undefined;
}

function claimedRequestIds(events: readonly OrchestrationGroupEvent[]): ReadonlySet<string> {
  return new Set(
    events.flatMap((event) => {
      switch (event.eventType) {
        case OrchestrationEventType.GroupClaimed:
          return [event.payload.requestId];
        case OrchestrationEventType.PrimaryClaimed:
          return [];
        default:
          return assertNever(event);
      }
    }),
  );
}

function groupEvents(
  events: ReadonlyArray<Parameters<typeof selectOrchestrationEvent>[0]>,
): readonly OrchestrationGroupEvent[] {
  return events
    .map(selectOrchestrationEvent)
    .filter(
      (event): event is OrchestrationGroupEvent =>
        event !== null && isOrchestrationGroupStream(event.stream),
    );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Orchestration group event: ${JSON.stringify(value)}`);
}
