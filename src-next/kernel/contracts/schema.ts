import { z } from 'zod';

export const offsetIsoTimestampSchema = z.iso.datetime({ offset: true });

export function brandedStringSchema<Output extends string>(construct: (value: string) => Output) {
  return z.string().transform((value, context) => {
    try {
      return construct(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        input: value,
        message: error instanceof Error ? error.message : 'Invalid branded string',
      });
      return z.NEVER;
    }
  });
}
