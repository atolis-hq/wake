import { WorkEventType, type WorkEvent } from '../contracts/events.js';
import type { WorkItemView, WorkState } from '../contracts/views.js';
import { WorkStatus } from '../contracts/vocabulary.js';

export function foldWorkItem(events: readonly WorkEvent[]): WorkItemView | null {
  if (events.length === 0) return null;
  if (events[0]?.event.eventType !== WorkEventType.ItemCreated) {
    throw new Error(`WorkItem stream must begin with ${WorkEventType.ItemCreated}`);
  }

  const id = events[0].stream.id;
  const state = {
    objective: events[0].event.payload.objective,
    tags: events[0].event.payload.tags ?? [],
    lifecycle: WorkStatus.Open as WorkState,
    autoApprovalGranted: false,
    frozen: false,
    deleted: false,
    links: [] as WorkItemView['relatedWorkItems'][number][],
    linkKeys: new Set<string>(),
  };
  for (const [index, event] of events.entries()) applyEvent(state, event, index, id);

  return {
    workItemId: id,
    objective: state.objective,
    state: state.lifecycle,
    tags: state.tags,
    autoApprovalGranted: state.autoApprovalGranted,
    frozen: state.frozen,
    deleted: state.deleted,
    relatedWorkItems: state.links,
  };
}

function applyEvent(
  state: {
    objective: string;
    tags: readonly string[];
    lifecycle: WorkState;
    autoApprovalGranted: boolean;
    frozen: boolean;
    deleted: boolean;
    links: WorkItemView['relatedWorkItems'][number][];
    linkKeys: Set<string>;
  },
  event: WorkEvent,
  index: number,
  id: string,
): void {
  if (event.stream.id !== id) {
    throw new Error('WorkItem events must belong to the same work-item stream');
  }
  switch (event.event.eventType) {
    case WorkEventType.ItemCreated:
      if (index > 0) throw new Error('WorkItem stream cannot contain a second creation event');
      break;
    case WorkEventType.ObjectiveRevised:
      state.objective = event.event.payload.objective;
      break;
    case WorkEventType.ItemLinked:
      addLink(state, {
        workItemId: event.event.payload.to,
        relation: event.event.payload.relation,
      });
      break;
    default:
      applyStatusEvent(state, event.event);
  }
}

function applyStatusEvent(
  state: {
    lifecycle: WorkState;
    autoApprovalGranted: boolean;
    frozen: boolean;
    deleted: boolean;
  },
  event: Exclude<
    WorkEvent['event'],
    {
      eventType:
        | typeof WorkEventType.ItemCreated
        | typeof WorkEventType.ObjectiveRevised
        | typeof WorkEventType.ItemLinked;
    }
  >,
): void {
  switch (event.eventType) {
    case WorkEventType.ItemClosed:
      state.lifecycle = WorkStatus.Closed;
      break;
    case WorkEventType.ItemCancelled:
      state.lifecycle = WorkStatus.Cancelled;
      break;
    case WorkEventType.AutoApprovalGranted:
      state.autoApprovalGranted = true;
      break;
    case WorkEventType.AutoApprovalRevoked:
      state.autoApprovalGranted = false;
      break;
    case WorkEventType.ItemFrozen:
      state.frozen = true;
      break;
    case WorkEventType.ItemUnfrozen:
      state.frozen = false;
      break;
    case WorkEventType.ItemDeleted:
      state.deleted = true;
      state.frozen = false;
      break;
    default:
      assertNever(event);
  }
}

function addLink(
  state: { links: WorkItemView['relatedWorkItems'][number][]; linkKeys: Set<string> },
  link: WorkItemView['relatedWorkItems'][number],
): void {
  const key = `${link.workItemId}:${link.relation}`;
  if (!state.linkKeys.has(key)) {
    state.linkKeys.add(key);
    state.links.push(link);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Work event: ${JSON.stringify(value)}`);
}
