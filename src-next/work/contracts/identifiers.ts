import type { Brand } from '../../kernel/index.js';

export type WorkItemId = Brand<string, 'WorkItemId'>;

export const workItemId = (value: string): WorkItemId => {
  if (!/^work-[a-z0-9-]+$/.test(value)) throw new Error(`Invalid WorkItemId: ${value}`);
  return value as WorkItemId;
};
