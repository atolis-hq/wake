import { createEventDraft, type CommandContext, type EventJournal } from '../../kernel/index.js';
import type { CreateWorkItem, LinkWorkItems, ReviseWorkObjective } from '../contracts/commands.js';
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
    eventType: string,
    payload: unknown,
    allowMissing = false,
  ): Promise<WorkItemView> {
    const loaded = await repository.load(workItemId);
    if (!allowMissing && loaded.view === null)
      throw new Error(`WorkItem ${workItemId} does not exist`);
    if (loaded.view !== null && loaded.view.state !== 'open') {
      throw new Error(`WorkItem ${workItemId} is ${loaded.view.state}`);
    }
    await repository.append(workItemId, loaded.sequence, [
      createEventDraft({
        eventId: `${context.commandId}:${eventType}`,
        eventType,
        occurredAt: context.occurredAt,
        correlationId: context.correlationId,
        causationId: context.commandId,
        actor: context.actor,
        source: { kind: 'internal', id: 'work-service' },
        stream: workItemStream(workItemId),
        payload,
      }),
    ]);
    const result = await repository.load(workItemId);
    if (result.view === null) throw new Error(`WorkItem ${workItemId} was not created`);
    return result.view;
  }

  return {
    async create(command, context) {
      const loaded = await repository.load(command.workItemId);
      if (loaded.view !== null) {
        return change(
          command.workItemId,
          context,
          'work.item-created',
          { objective: command.objective },
          true,
        );
      }
      return change(
        command.workItemId,
        context,
        'work.item-created',
        { objective: command.objective },
        true,
      );
    },
    revise(command, context) {
      return change(command.workItemId, context, 'work.objective-revised', {
        objective: command.objective,
      });
    },
    link(command, context) {
      return change(command.from, context, 'work.item-linked', {
        to: command.to,
        relation: command.relation,
      });
    },
    close(workItemId, reason, context) {
      return change(workItemId, context, 'work.item-closed', { reason });
    },
    cancel(workItemId, reason, context) {
      return change(workItemId, context, 'work.item-cancelled', { reason });
    },
    async get(workItemId) {
      return (await repository.load(workItemId)).view;
    },
  };
}
