import { EventSourceKind, type CommandContext, type EventJournal } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import { selectOrchestrationEvent } from '../contracts/event-decoder.js';
import { createOrchestrationEventData } from '../contracts/event-factory.js';
import type { ChildWorkflowRequest } from '../contracts/events.js';
import { OrchestrationEventType, type OrchestrationGroupEvent } from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import {
  isOrchestrationGroupStream,
  primaryOrchestrationGroupStream,
  type ChildOrchestrationGroupStreamRef,
} from '../contracts/streams.js';
import { ApprovalAuthorityKind } from '../contracts/vocabulary.js';
import { claimWithCasRetry } from './durable-append.js';

export class CoordinationClaims {
  constructor(private readonly journal: EventJournal) {}

  async claimPrimary(
    workItemId: WorkItemId,
    workflowInstanceId: WorkflowInstanceId,
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
        await this.journal.appendToStream(stream, sequence, [
          createOrchestrationEventData({
            eventId: `${context.commandId}:${OrchestrationEventType.PrimaryClaimed}:${workItemId}`,
            eventType: OrchestrationEventType.PrimaryClaimed,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
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
    const existing = groupEvents(await this.journal.readStream(stream));
    if (claimedRequestIds(existing).has(request.requestId)) return true;
    const claimed = await claimWithCasRetry({
      read: () => this.journal.readStream(stream),
      decode: groupEvents,
      alreadyClaimed: (events) => claimedRequestIds(events).has(request.requestId),
      canAppend: (_rawEvents, events) =>
        claimedRequestIds(events).size < request.maxPerGroup + budgetGrants(events),
      append: async (sequence) => {
        await this.journal.appendToStream(stream, sequence, [
          createOrchestrationEventData({
            eventId: `${context.commandId}:${OrchestrationEventType.GroupClaimed}:${request.requestId}`,
            eventType: OrchestrationEventType.GroupClaimed,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
            payload: { key: stream.id, requestId: request.requestId },
          }),
        ]);
      },
    });
    if (claimed) return true;
    return claimedRequestIds(groupEvents(await this.journal.readStream(stream))).has(
      request.requestId,
    );
  }

  async grantBudget(
    stream: ChildOrchestrationGroupStreamRef,
    requestId: string,
    context: CommandContext,
    authority: { readonly kind: string },
  ): Promise<void> {
    if (authority.kind !== ApprovalAuthorityKind.Human)
      throw new Error('A group budget extension requires human authority');
    await claimWithCasRetry({
      read: () => this.journal.readStream(stream),
      decode: groupEvents,
      alreadyClaimed: (events) =>
        events.some(
          (event) =>
            event.event.eventType === OrchestrationEventType.GroupBudgetGranted &&
            event.event.payload.commandId === context.commandId,
        ),
      append: async (sequence) => {
        await this.journal.appendToStream(stream, sequence, [
          createOrchestrationEventData({
            eventId: `${context.commandId}:${OrchestrationEventType.GroupBudgetGranted}:${requestId}`,
            eventType: OrchestrationEventType.GroupBudgetGranted,
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: EventSourceKind.Internal, id: 'orchestration-service' },
            payload: { key: stream.id, requestId, commandId: context.commandId },
          }),
        ]);
      },
    });
  }
}

function primaryOwner(events: readonly OrchestrationGroupEvent[]): string | undefined {
  for (const event of events) {
    switch (event.event.eventType) {
      case OrchestrationEventType.PrimaryClaimed:
        return event.event.payload.workflowInstanceId;
      case OrchestrationEventType.GroupClaimed:
      case OrchestrationEventType.GroupBudgetGranted:
        break;
      default:
        assertNever(event.event);
    }
  }
  return undefined;
}

function claimedRequestIds(events: readonly OrchestrationGroupEvent[]): ReadonlySet<string> {
  return new Set(
    events.flatMap((event) => {
      switch (event.event.eventType) {
        case OrchestrationEventType.GroupClaimed:
          return [event.event.payload.requestId];
        case OrchestrationEventType.PrimaryClaimed:
        case OrchestrationEventType.GroupBudgetGranted:
          return [];
        default:
          return assertNever(event.event);
      }
    }),
  );
}

function budgetGrants(events: readonly OrchestrationGroupEvent[]): number {
  return events.filter(
    (event) => event.event.eventType === OrchestrationEventType.GroupBudgetGranted,
  ).length;
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
