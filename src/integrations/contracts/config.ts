import { z } from 'zod';
import { surfaceCapabilitySchema } from '../../orchestration/index.js';

const conversationConfigSchema = z
  .object({ capabilities: z.array(surfaceCapabilitySchema).readonly() })
  .strict();

const providerEntrySchema = z
  .looseObject({
    provider: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    enabled: z.boolean().default(true),
    // This is adapter-instance policy. It is intentionally outside provider-specific
    // configuration so two instances of one provider can have different authority.
    conversation: conversationConfigSchema.optional(),
  })
  .transform((value) => ({ ...value, enabled: value.enabled ?? true }));

export const integrationsConfigSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]*$/), providerEntrySchema)
  .default({});

export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;
