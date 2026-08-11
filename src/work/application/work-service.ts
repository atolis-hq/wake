import {
  createEventDraft,
  EventSourceKind,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type { CreateWorkItem, LinkWorkItems, ReviseWorkObjective } from '../contracts/commands.js';
import { WorkEventType, type WorkEventDraft, type WorkEventPayloads } from '../contracts/events.js';
import type { WorkItemId } from '../contracts/identifiers.js';
import { workItemStream } from '../contracts/streams.js';
import type { WorkItemView } from '../contracts/views.js';
import { WorkStatus } from '../contracts/vocabulary.js';
import { WorkRepository } from './work-repository.js';

export interface WorkService {
  create(command: CreateWorkItem, context: CommandContext): Promise<WorkItemView>;
  revise(command: ReviseWorkObjective, context: CommandContext): Promise<WorkItemView>;
  link(command: LinkWorkItems, context: CommandContext): Promise<WorkItemView>;
  close(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  cancel(workItemId: WorkItemId, reason: string, context: CommandContext): Promise<WorkItemView>;
  grantAutoApproval(workItemId: WorkItemId, context: CommandContext): Promise<WorkItemView>;
  revokeAutoApproval(workItemId: WorkItemId, context: CommandContext): Promise<WorkItemView>;
  freeze(workItemId: WorkItemId, context: CommandContext): Promise<WorkItemView>;
  unfreeze(workItemId: WorkItemId, context: CommandContext): Promise<WorkItemView>;
  delete(workItemId: WorkItemId, context: CommandContext): Promise<WorkItemView>;
  get(workItemId: WorkItemId): Promise<WorkItemView | null>;
}

export function createWorkService(journal: EventJournal): WorkService {
  const repository = new WorkRepository(journal);
  const change = (
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventDraft,
    allowMissing?: boolean,
    requireOpen?: boolean,
  ) => changeWorkItem(repository, workItemId, context, draft, allowMissing, requireOpen);

  return {
    async create(command, context) {
      const loaded = await repository.load(command.workItemId);
      const draft = workDraft(command.workItemId, context, WorkEventType.ItemCreated, {
        objective: command.objective,
        ...(command.tags === undefined ? {} : { tags: command.tags }),
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
    grantAutoApproval(workItemId, context) {
      return setAutoApproval(repository, change, workItemId, context, true);
    },
    revokeAutoApproval(workItemId, context) {
      return setAutoApproval(repository, change, workItemId, context, false);
    },
    freeze(workItemId, context) {
      return setFrozen(repository, change, workItemId, context, true);
    },
    unfreeze(workItemId, context) {
      return setFrozen(repository, change, workItemId, context, false);
    },
    delete(workItemId, context) {
      return setDeleted(repository, change, workItemId, context);
    },
    async get(workItemId) {
      return (await repository.load(workItemId)).view;
    },
  };
}

async function changeWorkItem(
  repository: WorkRepository,
  workItemId: WorkItemId,
  context: CommandContext,
  draft: WorkEventDraft,
  allowMissing = false,
  requireOpen = true,
): Promise<WorkItemView> {
  const loaded = await repository.load(workItemId);
  if (!allowMissing && loaded.view === null)
    throw new Error(`WorkItem ${workItemId} does not exist`);
  if (loaded.view !== null && loaded.view.deleted) {
    throw new Error(`WorkItem ${workItemId} is deleted`);
  }
  if (requireOpen && loaded.view !== null && loaded.view.state !== WorkStatus.Open) {
    throw new Error(`WorkItem ${workItemId} is ${loaded.view.state}`);
  }
  await repository.append(workItemId, loaded.sequence, [draft]);
  const result = await repository.load(workItemId);
  if (result.view === null) throw new Error(`WorkItem ${workItemId} was not created`);
  return result.view;
}

// Operator consent is a durable sibling of freeze/unfreeze. Setting it to the value it
// already holds appends nothing, so replay cannot manufacture consent history.
async function setAutoApproval(
  repository: WorkRepository,
  change: (
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventDraft,
  ) => Promise<WorkItemView>,
  workItemId: WorkItemId,
  context: CommandContext,
  granted: boolean,
): Promise<WorkItemView> {
  const current = (await repository.load(workItemId)).view;
  if (current === null) throw new Error(`WorkItem ${workItemId} does not exist`);
  if (current.autoApprovalGranted === granted) return current;
  const eventType = granted ? WorkEventType.AutoApprovalGranted : WorkEventType.AutoApprovalRevoked;
  return change(workItemId, context, workDraft(workItemId, context, eventType, {}));
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

async function setFrozen(
  repository: WorkRepository,
  change: (
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventDraft,
  ) => Promise<WorkItemView>,
  workItemId: WorkItemId,
  context: CommandContext,
  frozen: boolean,
): Promise<WorkItemView> {
  const current = (await repository.load(workItemId)).view;
  if (current === null) throw new Error(`WorkItem ${workItemId} does not exist`);
  if (current.deleted) throw new Error(`WorkItem ${workItemId} is deleted`);
  if (current.frozen === frozen) return current;
  return change(
    workItemId,
    context,
    workDraft(
      workItemId,
      context,
      frozen ? WorkEventType.ItemFrozen : WorkEventType.ItemUnfrozen,
      {},
    ),
  );
}

async function setDeleted(
  repository: WorkRepository,
  change: (
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventDraft,
    allowMissing?: boolean,
    requireOpen?: boolean,
  ) => Promise<WorkItemView>,
  workItemId: WorkItemId,
  context: CommandContext,
): Promise<WorkItemView> {
  const current = (await repository.load(workItemId)).view;
  if (current === null) throw new Error(`WorkItem ${workItemId} does not exist`);
  if (current.deleted) return current;
  // Deletion is a purge escape hatch, not a lifecycle transition — unlike
  // freeze/revise/etc it must still work once a WorkItem is closed or
  // cancelled, since that's the common case operators need it for.
  return change(
    workItemId,
    context,
    workDraft(workItemId, context, WorkEventType.ItemDeleted, {}),
    false,
    false,
  );
}
