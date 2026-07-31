import {
  createEventDraft,
  type CommandContext,
  type EventEnvelope,
  type EventJournal,
  WrongExpectedSequenceError,
} from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { ChildWorkflowRequest } from '../contracts/events.js';
import {
  OrchestrationEventType,
  selectOrchestrationEvent,
  type OrchestrationGroupEvent,
} from '../contracts/events.js';
import {
  isOrchestrationGroupStream,
  primaryOrchestrationGroupStream,
  type ChildOrchestrationGroupStreamRef,
} from '../contracts/streams.js';

export class CoordinationClaims {
  constructor(private readonly journal: EventJournal) {}

  async claimPrimary(
    workItemId: WorkItemId,
    workflowInstanceId: string,
    context: CommandContext,
  ): Promise<void> {
    const stream = primaryOrchestrationGroupStream(workItemId);
    for (;;) {
      const events = await this.journal.readStream(stream);
      const owner = primaryOwner(groupEvents(events));
      if (owner !== undefined) {
        if (owner === workflowInstanceId) return;
        throw new Error(`WorkItem already has an active primary workflow owned by ${owner}`);
      }
      try {
        await this.journal.append(stream, events.length, [
          createEventDraft({
            eventId: `${context.commandId}:${OrchestrationEventType.PrimaryClaimed}:${workItemId}`,
            eventType: OrchestrationEventType.PrimaryClaimed,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: 'internal', id: 'orchestration-service' },
            stream,
            payload: { workItemId, workflowInstanceId },
          }),
        ]);
        return;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
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
    for (;;) {
      const events = await this.journal.readStream(stream);
      if (claimedRequestIds(groupEvents(events)).has(request.requestId)) return true;
      if (events.length >= request.maxPerGroup) return false;
      try {
        await this.journal.append(stream, events.length, [
          createEventDraft({
            eventId: `${context.commandId}:${OrchestrationEventType.GroupClaimed}:${request.requestId}`,
            eventType: OrchestrationEventType.GroupClaimed,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: 'internal', id: 'orchestration-service' },
            stream,
            payload: { key: stream.id, requestId: request.requestId },
          }),
        ]);
        return true;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
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

function groupEvents(events: readonly EventEnvelope[]): readonly OrchestrationGroupEvent[] {
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
