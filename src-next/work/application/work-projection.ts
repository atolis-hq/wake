import type { ProjectionDefinition } from '../../kernel/index.js';
import { workItemId } from '../contracts/identifiers.js';
import { isWorkItemStream } from '../contracts/streams.js';
import type { WorkItemView } from '../contracts/views.js';
export const workProjection: ProjectionDefinition<WorkItemView | null> = {
  name: 'work',
  select: (event) => (isWorkItemStream(event.stream) ? { key: event.stream.id } : null),
  initial: () => null,
  project(previous, event) {
    const payload = record(event.payload) ? event.payload : {};
    if (event.eventType === 'work.item-created')
      return {
        workItemId: workItemId(event.stream.id),
        objective: String(payload.objective),
        state: 'open',
        relatedWorkItems: [],
      };
    if (previous === null) return previous;
    if (event.eventType === 'work.objective-revised')
      return { ...previous, objective: String(payload.objective) };
    if (event.eventType === 'work.item-closed') return { ...previous, state: 'closed' };
    if (event.eventType === 'work.item-cancelled') return { ...previous, state: 'cancelled' };
    if (event.eventType === 'work.item-linked') {
      const link = {
        workItemId: workItemId(String(payload.to)),
        relation: payload.relation as WorkItemView['relatedWorkItems'][number]['relation'],
      };
      return previous.relatedWorkItems.some(
        (item) => item.workItemId === link.workItemId && item.relation === link.relation,
      )
        ? previous
        : { ...previous, relatedWorkItems: [...previous.relatedWorkItems, link] };
    }
    return previous;
  },
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
