import type { Brand } from '../../kernel/index.js';

export type AdapterId = Brand<string, 'AdapterId'>;

export const adapterId = (value: string): AdapterId => {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error(`Invalid AdapterId: ${value}`);
  return value as AdapterId;
};

export const GitHubAdapterId: AdapterId = adapterId('github');

export const BuiltInAdapterId = {
  GitHub: GitHubAdapterId,
} as const;
