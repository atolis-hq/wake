import { z } from 'zod';

const repositorySchema = z
  .object({ owner: z.string().trim().min(1), repo: z.string().trim().min(1) })
  .strict();
export const integrationsConfigSchema = z
  .object({
    github: z
      .object({
        enabled: z.boolean().default(false),
        token: z.string().optional(),
        repositories: z.array(repositorySchema).default([]),
        maxResults: z.number().int().positive().optional(),
      })
      .strict()
      .default({ enabled: false, repositories: [] }),
  })
  .strict()
  .default({ github: { enabled: false, repositories: [] } })
  .transform((value) => ({
    github: {
      enabled: value.github.enabled ?? false,
      repositories: value.github.repositories ?? [],
      ...(value.github.token === undefined ? {} : { token: value.github.token }),
      ...(value.github.maxResults === undefined ? {} : { maxResults: value.github.maxResults }),
    },
  }));
export type IntegrationsConfig = z.infer<typeof integrationsConfigSchema>;
