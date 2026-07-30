import {
  createEventDraft,
  entityRef,
  type CommandContext,
  type EventJournal,
  WrongExpectedSequenceError,
} from '../../kernel/index.js';
import type { ChildWorkflowRequest } from '../contracts/events.js';

export class CoordinationClaims {
  constructor(private readonly journal: EventJournal) {}

  async claimPrimary(
    workItemId: string,
    workflowInstanceId: string,
    context: CommandContext,
  ): Promise<void> {
    const stream = entityRef('orchestration-group', `primary:${workItemId}`);
    for (;;) {
      const events = await this.journal.readStream(stream);
      const owner = primaryOwner(events);
      if (owner !== undefined) {
        if (owner === workflowInstanceId) return;
        throw new Error(`WorkItem already has an active primary workflow owned by ${owner}`);
      }
      try {
        await this.journal.append(stream, events.length, [
          createEventDraft({
            eventId: `${context.commandId}:orchestration.primary-claimed:${workItemId}`,
            eventType: 'orchestration.primary-claimed',
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

  async primaryWorkflowInstanceId(workItemId: string): Promise<string | undefined> {
    return primaryOwner(
      await this.journal.readStream(entityRef('orchestration-group', `primary:${workItemId}`)),
    );
  }

  async claimWithinBudget(
    key: string,
    request: ChildWorkflowRequest & { readonly maxPerGroup: number },
    context: CommandContext,
  ): Promise<boolean> {
    const stream = entityRef('orchestration-group', key);
    for (;;) {
      const events = await this.journal.readStream(stream);
      if (claimedRequestIds(events).has(request.requestId)) return true;
      if (events.length >= request.maxPerGroup) return false;
      try {
        await this.journal.append(stream, events.length, [
          createEventDraft({
            eventId: `${context.commandId}:orchestration.group-claim:${request.requestId}`,
            eventType: 'orchestration.group-claimed',
            occurredAt: context.occurredAt,
            correlationId: context.correlationId,
            causationId: context.commandId,
            actor: context.actor,
            source: { kind: 'internal', id: 'orchestration-service' },
            stream,
            payload: { key, requestId: request.requestId },
          }),
        ]);
        return true;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }
}

function primaryOwner(events: readonly { readonly payload: unknown }[]): string | undefined {
  for (const event of events) {
    if (typeof event.payload !== 'object' || event.payload === null) continue;
    const owner = (event.payload as Record<string, unknown>).workflowInstanceId;
    if (typeof owner === 'string') return owner;
  }
  return undefined;
}

function claimedRequestIds(events: readonly { readonly payload: unknown }[]): ReadonlySet<string> {
  return new Set(
    events.flatMap((event) => {
      if (typeof event.payload !== 'object' || event.payload === null) return [];
      const requestId = (event.payload as Record<string, unknown>).requestId;
      return typeof requestId === 'string' ? [requestId] : [];
    }),
  );
}
