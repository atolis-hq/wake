import {
  createEventData,
  EventSourceKind,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type {
  AssociateConversationResource,
  CreateConversation,
  RecordConversationEntry,
  RecordConversationEntryRepresentation,
  ReviseConversationEntry,
  TombstoneConversationEntry,
} from '../contracts/commands.js';
import {
  ConversationEventType,
  type ConversationEventData,
  type ConversationEventPayloads,
} from '../contracts/events.js';
import { conversationIdForWorkItem, type ConversationId } from '../contracts/identifiers.js';
import { conversationStream } from '../contracts/streams.js';
import type { ConversationView } from '../contracts/views.js';
import { applyConversationEvent } from '../domain/conversation.js';
import { ConversationRepository } from './conversation-repository.js';

export interface ConversationService {
  create(command: CreateConversation, context: CommandContext): Promise<ConversationView>;
  createForWorkItem(
    workItemId: CreateConversation['workItemId'],
    context: CommandContext,
  ): Promise<ConversationView>;
  record(command: RecordConversationEntry, context: CommandContext): Promise<ConversationView>;
  associateResource(
    command: AssociateConversationResource,
    context: CommandContext,
  ): Promise<ConversationView>;
  revise(command: ReviseConversationEntry, context: CommandContext): Promise<ConversationView>;
  tombstone(
    command: TombstoneConversationEntry,
    context: CommandContext,
  ): Promise<ConversationView>;
  recordRepresentation(
    command: RecordConversationEntryRepresentation,
    context: CommandContext,
  ): Promise<ConversationView>;
  get(id: ConversationId): Promise<ConversationView | null>;
  forWorkItem(workItemId: CreateConversation['workItemId']): Promise<ConversationView | null>;
}

// The public service surface deliberately keeps all command handlers adjacent.
// eslint-disable-next-line max-lines-per-function
export function createConversationService(journal: EventJournal): ConversationService {
  const repository = new ConversationRepository(journal);
  const change = changeConversation(repository);
  const create = createConversation(repository, change);
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
    async associateResource(command, context) {
      const existing = await repository.load(command.conversationId);
      if (existing.view === null)
        throw new Error(`Conversation ${command.conversationId} does not exist`);
      if (
        existing.view.resources.some(
          (resource) =>
            resource.resourceId === command.resourceId && resource.threadId === command.threadId,
        )
      )
        return existing.view;
      return change(command.conversationId, context, ConversationEventType.ResourceAssociated, {
        resourceId: command.resourceId,
        ...(command.threadId === undefined ? {} : { threadId: command.threadId }),
      });
    },
    async revise(command, context) {
      const existing = await repository.load(command.conversationId);
      if (
        existing.view === null ||
        !existing.view.entries.some((entry) => entry.entryId === command.entryId)
      )
        throw new Error(`Conversation entry ${command.entryId} does not exist`);
      return change(command.conversationId, context, ConversationEventType.EntryRevised, {
        entryId: command.entryId,
        body: command.body,
      });
    },
    async tombstone(command, context) {
      const existing = await repository.load(command.conversationId);
      if (
        existing.view === null ||
        !existing.view.entries.some((entry) => entry.entryId === command.entryId)
      )
        throw new Error(`Conversation entry ${command.entryId} does not exist`);
      return change(command.conversationId, context, ConversationEventType.EntryTombstoned, {
        entryId: command.entryId,
      });
    },
    async recordRepresentation(command, context) {
      const existing = await repository.load(command.conversationId);
      const entry = existing.view?.entries.find(
        (candidate) => candidate.entryId === command.entryId,
      );
      if (entry === undefined)
        throw new Error(`Conversation entry ${command.entryId} does not exist`);
      if (
        entry.representations.some(
          (representation) =>
            representation.resourceId === command.resourceId &&
            representation.externalId === command.externalId,
        )
      )
        return existing.view!;
      return change(
        command.conversationId,
        context,
        ConversationEventType.EntryRepresentationRecorded,
        {
          entryId: command.entryId,
          resourceId: command.resourceId,
          externalId: command.externalId,
        },
      );
    },
    get: async (id) => (await repository.load(id)).view,
    forWorkItem: async (workItemId) =>
      (await repository.load(conversationIdForWorkItem(workItemId))).view,
  };
}

function changeConversation(repository: ConversationRepository) {
  return async <Type extends keyof ConversationEventPayloads>(
    id: ConversationId,
    context: CommandContext,
    eventType: Type,
    payload: ConversationEventPayloads[Type],
  ) => {
    const loaded = await repository.load(id);
    const draft = createEventData({
      eventId: `${context.commandId}:${eventType}`,
      eventType,
      occurredAt: context.occurredAt,
      correlationId: context.correlationId,
      causationId: context.commandId,
      actor: context.actor,
      source: { kind: EventSourceKind.Internal, id: 'conversation-service' },
      stream: conversationStream(id),
      payload,
    }) as ConversationEventData;
    const [recorded] = await repository.append(id, loaded.sequence, [draft]);
    const next = recorded === undefined ? null : applyConversationEvent(loaded.view, recorded);
    if (next === null) throw new Error(`Conversation ${id} was not created`);
    return next;
  };
}

function createConversation(
  repository: ConversationRepository,
  change: ReturnType<typeof changeConversation>,
) {
  return async (command: CreateConversation, context: CommandContext) => {
    const existing = await repository.load(command.conversationId);
    return (
      existing.view ??
      change(command.conversationId, context, ConversationEventType.Created, {
        workItemId: command.workItemId,
      })
    );
  };
}
