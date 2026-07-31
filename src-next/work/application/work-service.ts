import { WorkStatus } from '../contracts/vocabulary.js';
import { EventSourceKind } from '../../kernel/index.js';
import { createEventDraft, type CommandContext, type EventJournal } from '../../kernel/index.js';
import type { CreateWorkItem, LinkWorkItems, ReviseWorkObjective } from '../contracts/commands.js';
import { WorkEventType, type WorkEventDraft, type WorkEventPayloads } from '../contracts/events.js';
import type { WorkItemId } from '../contracts/identifiers.js';
import { workItemStream } from '../contracts/streams.js';
import type { WorkItemView } from '../contracts/views.js';
import { WorkRepository } from './work-repository.js';

export interface WorkService {
  create(command: CreateWorkItem, context: CommandContext): Promise<WorkItemView>;
  revise(command: ReviseWorkObjective, context: CommandContext): Promise<WorkItemView>;
  link(command: LinkWorkItems, context: CommandContext): Promise<WorkItemView>;
  close(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  cancel(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  get(workItemId: WorkItemId): Promise<WorkItemView | null>;
}

export function createWorkService(journal: EventJournal): WorkService {
  const repository = new WorkRepository(journal);

  async function change(
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventDraft,
    allowMissing = false,
  ): Promise<WorkItemView> {
    const loaded = await repository.load(workItemId);
    if (!allowMissing && loaded.view === null)
      throw new Error(`WorkItem ${workItemId} does not exist`);
    if (loaded.view !== null && loaded.view.state !== WorkStatus.Open) {
      throw new Error(`WorkItem ${workItemId} is ${loaded.view.state}`);
    }
    await repository.append(workItemId, loaded.sequence, [draft]);
    const result = await repository.load(workItemId);
    if (result.view === null) throw new Error(`WorkItem ${workItemId} was not created`);
    return result.view;
  }

  return {
    async create(command, context) {
      const loaded = await repository.load(command.workItemId);
      const draft = workDraft(command.workItemId, context, WorkEventType.ItemCreated, {
        objective: command.objective,
      });
      if (loaded.view !== null) return change(command.workItemId, context, draft, true);
      return change(command.workItemId, context, draft, true);
    },
    revise(command, context) {
      return change(
        command.workItemId,
        context,
        workDraft(command.workItemId, context, WorkEventType.ObjectiveRevised, {
          objective: command.objective,
        }),
      );
    },
    link(command, context) {
      return change(
        command.from,
        context,
        workDraft(command.from, context, WorkEventType.ItemLinked, {
          to: command.to,
          relation: command.relation,
        }),
      );
    },
    close(workItemId, reason, context) {
      return change(
        workItemId,
        context,
        workDraft(workItemId, context, WorkEventType.ItemClosed, { reason }),
      );
    },
    cancel(workItemId, reason, context) {
      return change(
        workItemId,
        context,
        workDraft(workItemId, context, WorkEventType.ItemCancelled, { reason }),
      );
    },
    async get(workItemId) {
      return (await repository.load(workItemId)).view;
    },
  };
}

function workDraft<Type extends keyof WorkEventPayloads>(
  workItemId: WorkItemId,
  context: CommandContext,
  eventType: Type,
  payload: WorkEventPayloads[Type],
) {
  return createEventDraft({
    eventId: `${context.commandId}:${eventType}`,
    eventType,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'work-service' },
    stream: workItemStream(workItemId),
    payload,
  });
}
