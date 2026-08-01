import { WorkStatus } from '../contracts/vocabulary.js';
import type { ProjectionDefinition } from '../../kernel/index.js';
import { selectWorkEvent, WorkEventType } from '../contracts/events.js';
import type { WorkItemView } from '../contracts/views.js';
export const workProjection: ProjectionDefinition<WorkItemView | null> = {
  name: 'work',
  select(event) {
    const owned = selectWorkEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectWorkEvent(event);
    if (owned === null) return previous;
    if (owned.eventType === WorkEventType.ItemCreated)
      return {
        workItemId: owned.stream.id,
        objective: owned.payload.objective,
        state: WorkStatus.Open,
        tags: owned.payload.tags ?? [],
        autoApprovalGranted: false,
        relatedWorkItems: [],
      };
    // Every other event revises an existing item; a fold that has not seen the creation
    // yet has nothing to revise.
    return previous === null ? previous : revise(previous, owned);
  },
};

type ExistingWorkEvent = Exclude<
  ReturnType<typeof selectWorkEvent>,
  null | { eventType: typeof WorkEventType.ItemCreated }
>;

function revise(previous: WorkItemView, owned: ExistingWorkEvent): WorkItemView {
  switch (owned.eventType) {
    case WorkEventType.ObjectiveRevised:
      return { ...previous, objective: owned.payload.objective };
    case WorkEventType.ItemClosed:
      return { ...previous, state: WorkStatus.Closed };
    case WorkEventType.ItemCancelled:
      return { ...previous, state: WorkStatus.Cancelled };
    case WorkEventType.AutoApprovalGranted:
      return { ...previous, autoApprovalGranted: true };
    case WorkEventType.AutoApprovalRevoked:
      return { ...previous, autoApprovalGranted: false };
    case WorkEventType.ItemLinked:
      return link(previous, owned.payload.to, owned.payload.relation);
    default:
      return assertNever(owned);
  }
}

function link(
  previous: WorkItemView,
  workItemId: WorkItemView['relatedWorkItems'][number]['workItemId'],
  relation: WorkItemView['relatedWorkItems'][number]['relation'],
): WorkItemView {
  return previous.relatedWorkItems.some(
    (item) => item.workItemId === workItemId && item.relation === relation,
  )
    ? previous
    : { ...previous, relatedWorkItems: [...previous.relatedWorkItems, { workItemId, relation }] };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Work event: ${JSON.stringify(value)}`);
}
