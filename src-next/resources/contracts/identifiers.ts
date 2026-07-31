import type { Brand } from '../../kernel/index.js';

export type ResourceId = Brand<string, 'ResourceId'>;
export type ResourceKind = Brand<string, 'ResourceKind'>;
export type ResourceCapability = Brand<string, 'ResourceCapability'>;

export const resourceId = (value: string): ResourceId => {
  if (!/^resource-[a-z0-9-]+$/.test(value)) throw new Error(`Invalid ResourceId: ${value}`);
  return value as ResourceId;
};

export const resourceKind = (value: string): ResourceKind => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value))
    throw new Error(`Invalid Resource kind: ${value}`);
  return value as ResourceKind;
};

export const resourceCapability = (value: string): ResourceCapability => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value))
    throw new Error(`Invalid Resource capability: ${value}`);
  return value as ResourceCapability;
};
