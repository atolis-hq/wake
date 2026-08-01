import { z } from 'zod';

const providerEntrySchema = z
  .looseObject({
    provider: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    enabled: z.boolean().default(true),
  })
  .transform((value) => ({ ...value, enabled: value.enabled ?? true }));

export const integrationsConfigSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]*$/), providerEntrySchema)
  .default({});
export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;
