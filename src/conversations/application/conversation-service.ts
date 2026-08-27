import {
  createEventDraft,
  EventSourceKind,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type { CreateConversation, RecordConversationEntry } from '../contracts/commands.js';
import {
  ConversationEventType,
  type ConversationEventDraft,
  type ConversationEventPayloads,
} from '../contracts/events.js';
import { conversationIdForWorkItem, type ConversationId } from '../contracts/identifiers.js';
import { conversationStream } from '../contracts/streams.js';
import type { ConversationView } from '../contracts/views.js';
import { ConversationRepository } from './conversation-repository.js';

export interface ConversationService {
  create(command: CreateConversation, context: CommandContext): Promise<ConversationView>;
  createForWorkItem(
    workItemId: CreateConversation['workItemId'],
    context: CommandContext,
  ): Promise<ConversationView>;
  record(command: RecordConversationEntry, context: CommandContext): Promise<ConversationView>;
  get(id: ConversationId): Promise<ConversationView | null>;
  forWorkItem(workItemId: CreateConversation['workItemId']): Promise<ConversationView | null>;
}
export function createConversationService(journal: EventJournal): ConversationService {
  const repository = new ConversationRepository(journal);
  const change = async <Type extends keyof ConversationEventPayloads>(
    id: ConversationId,
    context: CommandContext,
    eventType: Type,
    payload: ConversationEventPayloads[Type],
  ) => {
    const loaded = await repository.load(id);
    const draft = createEventDraft({
      eventId: `${context.commandId}:${eventType}`,
      eventType,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'conversation-service' },
      stream: conversationStream(id),
      payload,
    }) as ConversationEventDraft;
    await repository.append(id, loaded.sequence, [draft]);
    const result = await repository.load(id);
    if (result.view === null) throw new Error(`Conversation ${id} was not created`);
    return result.view;
  };
  const create = async (command: CreateConversation, context: CommandContext) => {
    const existing = await repository.load(command.conversationId);
    return (
      existing.view ??
      change(command.conversationId, context, ConversationEventType.Created, {
        workItemId: command.workItemId,
      })
    );
  };
  return {
    create,
    createForWorkItem: (workItemId, context) =>
      create({ conversationId: conversationIdForWorkItem(workItemId), workItemId }, context),
    async record(command, context) {
      const existing = await repository.load(command.conversationId);
      if (existing.view === null)
        throw new Error(`Conversation ${command.conversationId} does not exist`);
      if (existing.view.entries.some((entry) => entry.entryId === command.entryId))
        return existing.view;
      return change(command.conversationId, context, ConversationEventType.EntryRecorded, {
        entryId: command.entryId,
        body: command.body,
        origin: command.origin,
      });
    },
    get: async (id) => (await repository.load(id)).view,
    forWorkItem: async (workItemId) =>
      (await repository.load(conversationIdForWorkItem(workItemId))).view,
  };
}
