import { isDeepStrictEqual } from 'node:util';
import {
  EventSourceKind,
  WrongExpectedSequenceError,
  type CommandContext,
  type EventJournal,
} from '../../kernel/index.js';
import type { CreateWorkItem, LinkWorkItems, ReviseWorkObjective } from '../contracts/commands.js';
import { createWorkEventData } from '../contracts/event-factory.js';
import {
  WorkEventType,
  type WorkEvent,
  type WorkEventData,
  type WorkEventPayloads,
} from '../contracts/events.js';
import type { WorkItemId } from '../contracts/identifiers.js';
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
    draft: WorkEventData,
    allowMissing?: boolean,
    requireOpen?: boolean,
  ) => changeWorkItem(repository, workItemId, context, draft, allowMissing, requireOpen);

  return {
    async create(command, context) {
      const loaded = await repository.load(command.workItemId);
      const draft = workDraft(context, {
        eventType: WorkEventType.ItemCreated,
        payload: {
          objective: command.objective,
          ...(command.tags === undefined ? {} : { tags: command.tags }),
        },
      });
      if (loaded.view !== null) return change(command.workItemId, context, draft, true);
      return change(command.workItemId, context, draft, true);
    },
    revise(command, context) {
      return change(
        command.workItemId,
        context,
        workDraft(context, {
          eventType: WorkEventType.ObjectiveRevised,
          payload: { objective: command.objective },
        }),
      );
    },
    link(command, context) {
      return change(
        command.from,
        context,
        workDraft(context, {
          eventType: WorkEventType.ItemLinked,
          payload: { to: command.to, relation: command.relation },
        }),
      );
    },
    close(workItemId, reason, context) {
      return change(
        workItemId,
        context,
        workDraft(context, { eventType: WorkEventType.ItemClosed, payload: { reason } }),
      );
    },
    cancel(workItemId, reason, context) {
      return change(
        workItemId,
        context,
        workDraft(context, { eventType: WorkEventType.ItemCancelled, payload: { reason } }),
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
  draft: WorkEventData,
  allowMissing = false,
  requireOpen = true,
): Promise<WorkItemView> {
  const loaded = await repository.load(workItemId);
  const replayed = replayedWorkChange(loaded.events, loaded.view, draft, workItemId);
  if (replayed !== undefined) return replayed;
  assertWorkChangeAllowed(loaded.view, workItemId, allowMissing, requireOpen);
  const concurrentReplay = await appendWorkChange(repository, workItemId, loaded.sequence, draft);
  if (concurrentReplay !== undefined) return concurrentReplay;
  const result = await repository.load(workItemId);
  if (result.view === null) throw new Error(`WorkItem ${workItemId} was not created`);
  return result.view;
}

function assertWorkChangeAllowed(
  view: WorkItemView | null,
  workItemId: WorkItemId,
  allowMissing: boolean,
  requireOpen: boolean,
): void {
  if (!allowMissing && view === null) throw new Error(`WorkItem ${workItemId} does not exist`);
  if (view?.deleted === true) throw new Error(`WorkItem ${workItemId} is deleted`);
  if (requireOpen && view !== null && view.state !== WorkStatus.Open)
    throw new Error(`WorkItem ${workItemId} is ${view.state}`);
}

async function appendWorkChange(
  repository: WorkRepository,
  workItemId: WorkItemId,
  expectedSequence: number,
  draft: WorkEventData,
): Promise<WorkItemView | undefined> {
  try {
    await repository.append(workItemId, expectedSequence, [draft]);
    return undefined;
  } catch (error) {
    if (!(error instanceof WrongExpectedSequenceError)) throw error;
    const concurrent = await repository.load(workItemId);
    const replayed = replayedWorkChange(concurrent.events, concurrent.view, draft, workItemId);
    if (replayed !== undefined) return replayed;
    throw error;
  }
}

function replayedWorkChange(
  events: readonly WorkEvent[],
  view: WorkItemView | null,
  draft: WorkEventData,
  workItemId: WorkItemId,
): WorkItemView | undefined {
  const prior = events.find((event) => event.event.eventId === draft.eventId);
  if (prior === undefined) return undefined;
  if (!isDeepStrictEqual(prior.event, draft))
    throw new Error(`Work event id ${draft.eventId} has already been used with different content`);
  if (view === null) throw new Error(`WorkItem ${workItemId} was not created`);
  return view;
}

// Operator consent is a durable sibling of freeze/unfreeze. Setting it to the value it
// already holds appends nothing, so replay cannot manufacture consent history.
async function setAutoApproval(
  repository: WorkRepository,
  change: (
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventData,
  ) => Promise<WorkItemView>,
  workItemId: WorkItemId,
  context: CommandContext,
  granted: boolean,
): Promise<WorkItemView> {
  const current = (await repository.load(workItemId)).view;
  if (current === null) throw new Error(`WorkItem ${workItemId} does not exist`);
  if (current.autoApprovalGranted === granted) return current;
  const input = granted
    ? { eventType: WorkEventType.AutoApprovalGranted, payload: {} }
    : { eventType: WorkEventType.AutoApprovalRevoked, payload: {} };
  return change(workItemId, context, workDraft(context, input));
}

type WorkDraftInput = {
  [Type in keyof WorkEventPayloads]: {
    readonly eventType: Type;
    readonly payload: WorkEventPayloads[Type];
  };
}[keyof WorkEventPayloads];

function workDraft(context: CommandContext, input: WorkDraftInput): WorkEventData {
  return createWorkEventData({
    eventId: `${context.commandId}:${input.eventType}`,
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'work-service' },
    ...input,
  });
}

async function setFrozen(
  repository: WorkRepository,
  change: (
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventData,
  ) => Promise<WorkItemView>,
  workItemId: WorkItemId,
  context: CommandContext,
  frozen: boolean,
): Promise<WorkItemView> {
  const current = (await repository.load(workItemId)).view;
  if (current === null) throw new Error(`WorkItem ${workItemId} does not exist`);
  if (current.deleted) throw new Error(`WorkItem ${workItemId} is deleted`);
  if (current.frozen === frozen) return current;
  const input = frozen
    ? { eventType: WorkEventType.ItemFrozen, payload: {} }
    : { eventType: WorkEventType.ItemUnfrozen, payload: {} };
  return change(workItemId, context, workDraft(context, input));
}

async function setDeleted(
  repository: WorkRepository,
  change: (
    workItemId: WorkItemId,
    context: CommandContext,
    draft: WorkEventData,
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
    workDraft(context, { eventType: WorkEventType.ItemDeleted, payload: {} }),
    false,
    false,
  );
}
