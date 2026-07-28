import type { IssueStateRecord } from './types.js';

export const FROZEN_WORK_ITEM_LABEL = 'wake:frozen';

export function isWorkItemDeleted(item: IssueStateRecord): boolean {
  return typeof item.context.deletedAt === 'string';
}

export function isWorkItemFrozen(item: IssueStateRecord): boolean {
  return typeof item.context.frozenAt === 'string';
}

export function isWorkItemRunnable(item: IssueStateRecord): boolean {
  return !isWorkItemDeleted(item) && !isWorkItemFrozen(item);
}
