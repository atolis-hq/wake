import { z } from 'zod';
import { MatchMode } from '../../../kernel/index.js';
import { isGitHubWakeMarker } from './vocabulary.js';

const repositorySchema = z
  .object({ owner: z.string().trim().min(1), repo: z.string().trim().min(1) })
  .strict();
const intakeTag = z
  .string()
  .trim()
  .min(1)
  .refine((tag) => !isGitHubWakeMarker(tag), {
    message:
      'intake tags must not come from a Wake-owned marker family; Wake would observe its own marker and re-route',
  });
const intakeRuleSchema = z
  .object({
    where: z
      .object({
        kind: z.enum(['issue', 'pull-request']).optional(),
        requiredAssignees: z.array(z.string().trim().min(1)).default([]),
        requiredAuthors: z.array(z.string().trim().min(1)).default([]),
        labels: z.array(z.string().trim().min(1)).default([]),
      })
      .strict(),
    matchMode: z.enum([MatchMode.Any, MatchMode.All]).default(MatchMode.Any),
    tags: z.array(intakeTag).default([]),
  })
  .strict();

export const gitHubConfigSchema = z
  .object({
    enabled: z.boolean(),
    token: z.string().trim().min(1),
    repositories: z.array(repositorySchema).min(1),
    polling: z
      .object({
        maxPerRepo: z.number().int().positive().default(25),
        commentPageSize: z.number().int().positive().max(100).default(25),
        lookbackMs: z.number().int().nonnegative().default(60_000),
      })
      .strict()
      .default({ maxPerRepo: 25, commentPageSize: 25, lookbackMs: 60_000 }),
    intake: z.array(intakeRuleSchema).default([]),
    publication: z
      .object({ postStatusComments: z.boolean().default(true) })
      .strict()
      .default({ postStatusComments: true }),
  })
  .strict();

export type GitHubConfig = z.output<typeof gitHubConfigSchema>;
export type GitHubIntakeRuleConfig = GitHubConfig['intake'][number];
