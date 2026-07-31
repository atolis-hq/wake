import type { Brand } from '../../kernel/index.js';

export type ActivationId = Brand<string, 'ActivationId'>;

export const activationId = (value: string): ActivationId => {
  if (value.trim().length === 0) throw new Error('ActivationId must not be empty');
  return value as ActivationId;
};
