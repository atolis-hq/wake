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
    switch (owned.eventType) {
      case WorkEventType.ItemCreated:
        return {
          workItemId: owned.stream.id,
          objective: owned.payload.objective,
          state: WorkStatus.Open,
          relatedWorkItems: [],
        };
      case WorkEventType.ObjectiveRevised:
        return previous === null ? previous : { ...previous, objective: owned.payload.objective };
      case WorkEventType.ItemClosed:
        return previous === null ? previous : { ...previous, state: WorkStatus.Closed };
      case WorkEventType.ItemCancelled:
        return previous === null ? previous : { ...previous, state: WorkStatus.Cancelled };
      case WorkEventType.ItemLinked: {
        if (previous === null) return previous;
        const link = {
          workItemId: owned.payload.to,
          relation: owned.payload.relation,
        };
        return previous.relatedWorkItems.some(
          (item) => item.workItemId === link.workItemId && item.relation === link.relation,
        )
          ? previous
          : { ...previous, relatedWorkItems: [...previous.relatedWorkItems, link] };
      }
      default:
        return assertNever(owned);
    }
  },
};

function assertNever(value: never): never {
  throw new Error(`Unhandled Work event: ${JSON.stringify(value)}`);
}
