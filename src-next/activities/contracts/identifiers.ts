import type { Brand } from '../../kernel/index.js';

export type ActivityName = Brand<string, 'ActivityName'>;
export type ActivationId = Brand<string, 'ActivationId'>;

export const activityName = (value: string): ActivityName => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))
    throw new Error(`Invalid Activity name: ${value}`);
  return value as ActivityName;
};

export const activationId = (value: string): ActivationId => {
  if (value.trim().length === 0) throw new Error('ActivationId must not be empty');
  if (!isWellFormedUnicode(value)) throw new Error('ActivationId must contain well-formed Unicode');
  return value as ActivationId;
};

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
