import type { Brand } from '../../kernel/index.js';

export type ResourceId = Brand<string, 'ResourceId'>;

export const resourceId = (value: string): ResourceId => {
  if (!/^resource-[a-z0-9-]+$/.test(value)) throw new Error(`Invalid ResourceId: ${value}`);
  return value as ResourceId;
};
