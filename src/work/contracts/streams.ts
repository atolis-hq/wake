import type { EntityRef } from '../../kernel/index.js';
import type { WorkItemId } from './identifiers.js';

export const WorkStreamKind = { WorkItem: 'work-item' } as const;

export type WorkItemStreamRef = EntityRef<typeof WorkStreamKind.WorkItem, WorkItemId>;

export const workItemStream = (id: WorkItemId): WorkItemStreamRef => ({
  kind: WorkStreamKind.WorkItem,
  id,
});

export const isWorkItemStream = (stream: EntityRef): stream is WorkItemStreamRef =>
  stream.kind === WorkStreamKind.WorkItem;
