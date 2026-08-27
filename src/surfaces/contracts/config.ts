import { z } from 'zod';

export const surfacesConfigSchema = z
  .object({
    api: z
      .object({
        enabled: z.boolean().default(false),
        host: z.string().default('127.0.0.1'),
        port: z.number().int().positive().default(4317),
        conversationMessages: z
          .object({ enabled: z.boolean().default(false) })
          .strict()
          .default({ enabled: false }),
      })
      .strict()
      .default({
        enabled: false,
        host: '127.0.0.1',
        port: 4317,
        conversationMessages: { enabled: false },
      }),
    web: z
      .object({
        enabled: z.boolean().default(false),
        auth: z
          .object({ disabled: z.boolean().default(false) })
          .strict()
          .default({ disabled: false }),
        publicUrl: z
          .string()
          .trim()
          .url()
          .refine((value) => new URL(value).protocol === 'https:', {
            message: 'Web public URL must use HTTPS',
          })
          .optional(),
      })
      .strict()
      .default({ enabled: false, auth: { disabled: false } }),
  })
  .strict()
  .default({
    api: {
      enabled: false,
      host: '127.0.0.1',
      port: 4317,
      conversationMessages: { enabled: false },
    },
    web: { enabled: false, auth: { disabled: false } },
  })
  .superRefine((value, context) => {
    if (value.web.enabled && !value.api.enabled)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['web', 'enabled'],
        message: 'Web surface requires the API surface',
      });
  })
  .transform((value) => ({
    api: {
      enabled: value.api.enabled ?? false,
      host: value.api.host ?? '127.0.0.1',
      port: value.api.port ?? 4317,
      conversationMessages: { enabled: value.api.conversationMessages.enabled ?? false },
    },
    web: {
      enabled: value.web.enabled ?? false,
      auth: { disabled: value.web.auth.disabled ?? false },
      ...(value.web.publicUrl === undefined ? {} : { publicUrl: value.web.publicUrl }),
    },
  }));

export type SurfacesConfig = z.infer<typeof surfacesConfigSchema>;
