import type { Brand } from '../../kernel/index.js';

export type RunId = Brand<string, 'RunId'>;

export const runId = (value: string): RunId => {
  if (value.trim().length === 0) throw new Error('RunId must not be empty');
  return value as RunId;
};
