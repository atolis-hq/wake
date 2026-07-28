import type { IssueStateRecord } from './types.js';

export const FROZEN_WORK_ITEM_LABEL = 'wake:frozen';

export function isWorkItemDeleted(item: IssueStateRecord): boolean {
  return item.context.deleted !== undefined;
}

export function isWorkItemFrozen(item: IssueStateRecord): boolean {
  return item.context.frozen !== undefined;
}

export function isWorkItemRunnable(item: IssueStateRecord): boolean {
  return !isWorkItemDeleted(item) && !isWorkItemFrozen(item);
}
