import type { Brand } from '../../kernel/index.js';

export type WorkItemId = Brand<string, 'WorkItemId'>;

export const workItemId = (value: string): WorkItemId => {
  if (!/^work-[0-9a-hjkmnp-tv-z]{26}$/.test(value))
    throw new Error(`Invalid WorkItemId: ${value}. WorkItem identity is minted, never derived.`);
  return value as WorkItemId;
};
