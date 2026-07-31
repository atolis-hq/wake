import { z } from 'zod';

export const surfacesConfigSchema = z
  .object({
    api: z
      .object({
        enabled: z.boolean().default(false),
        port: z.number().int().positive().default(4317),
      })
      .strict()
      .default({ enabled: false, port: 4317 }),
  })
  .strict()
  .default({ api: { enabled: false, port: 4317 } })
  .transform((value) => ({
    api: { enabled: value.api.enabled ?? false, port: value.api.port ?? 4317 },
  }));
export type SurfacesConfig = z.infer<typeof surfacesConfigSchema>;
