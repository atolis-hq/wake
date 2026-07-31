import { z } from 'zod';

export const surfacesConfigSchema = z
  .object({
    api: z
      .object({
        enabled: z.boolean().default(false),
        host: z.string().default('127.0.0.1'),
        port: z.number().int().positive().default(4317),
      })
      .strict()
      .default({ enabled: false, host: '127.0.0.1', port: 4317 }),
    web: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .default({ enabled: false }),
  })
  .strict()
  .default({ api: { enabled: false, host: '127.0.0.1', port: 4317 }, web: { enabled: false } })
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
    },
    web: { enabled: value.web.enabled ?? false },
  }));
export type SurfacesConfig = z.infer<typeof surfacesConfigSchema>;
