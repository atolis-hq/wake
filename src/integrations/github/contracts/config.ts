import { z } from 'zod';
import { MatchMode } from '../../../kernel/index.js';
import {
  type ReplyOutcome,
  ReplyOutcomeConfig,
  ReplyTarget,
} from '../../contracts/reply-routing.js';
import { isGitHubWakeMarker } from './vocabulary.js';

const replyTargetSchema = z.enum(Object.values(ReplyTarget));
const replyOutcomeSchema = z
  .enum(Object.values(ReplyOutcomeConfig))
  .transform((value): ReplyOutcome => replyOutcomeMap[value]);
const replyOutcomeMap: Readonly<
  Record<(typeof ReplyOutcomeConfig)[keyof typeof ReplyOutcomeConfig], ReplyOutcome>
> = {
  [ReplyOutcomeConfig.Done]: 'DONE',
  [ReplyOutcomeConfig.Rejected]: 'REJECTED',
  [ReplyOutcomeConfig.Blocked]: 'BLOCKED',
  [ReplyOutcomeConfig.Failed]: 'FAILED',
  [ReplyOutcomeConfig.NeedsClarification]: 'NEEDS_CLARIFICATION',
} as const;
const replySelectorValues = <T extends z.ZodType>(value: T) =>
  z
    .union([value, z.array(value).min(1)])
    .transform((values): readonly z.output<T>[] => (Array.isArray(values) ? values : [values]));
const replyRuleSchema = z
  .object({
    match: z
      .object({
        stage: replySelectorValues(z.string().trim().min(1)).optional(),
        outcome: replySelectorValues(replyOutcomeSchema).optional(),
      })
      .strict()
      .refine((value) => Object.values(value).some((facet) => facet !== undefined), {
        message: 'Reply routing match requires at least one facet',
      }),
    matchMode: z.enum([MatchMode.Any, MatchMode.All]).default(MatchMode.Any),
    target: replyTargetSchema,
  })
  .strict();
const replyPublicationSchema = z
  .object({
    rules: z.array(replyRuleSchema).default([]),
    default: replyTargetSchema.default(ReplyTarget.Primary),
  })
  .strict()
  .default({ rules: [], default: ReplyTarget.Primary });

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
    ignoredLabels: z.array(z.string().trim().min(1)).default([]),
    tags: z.array(intakeTag).default([]),
  })
  .strict();

export const gitHubConfigSchema = z
  .object({
    enabled: z.boolean(),
    token: z.string().trim().min(1).optional(),
    repositories: z.array(repositorySchema).min(1),
    polling: z
      .object({
        maxPerRepo: z.number().int().positive().default(25),
        maxConcurrent: z.number().int().positive().default(4),
        commentPageSize: z.number().int().positive().max(100).default(25),
        lookbackMs: z.number().int().nonnegative().default(60_000),
        intervalMs: z.number().int().positive().default(30_000),
      })
      .strict()
      .default({
        maxPerRepo: 25,
        maxConcurrent: 4,
        commentPageSize: 25,
        lookbackMs: 60_000,
        intervalMs: 30_000,
      }),
    intake: z.array(intakeRuleSchema).default([]),
    publication: z
      .object({
        postStatusComments: z.boolean().default(true),
        replies: replyPublicationSchema,
      })
      .strict()
      .default({ postStatusComments: true, replies: { rules: [], default: ReplyTarget.Primary } }),
    // Additional command syntax to advertise on the commands/instructions
    // surface alongside the adapter's built-in commands. Purely descriptive:
    // Wake does not recognize these itself, so any behavior they imply must
    // be handled by whatever reads the comment (e.g. a workflow prompt).
    commands: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export type GitHubConfig = z.output<typeof gitHubConfigSchema>;

export type GitHubIntakeRuleConfig = GitHubConfig['intake'][number];

export type GitHubReplyPublicationConfig = GitHubConfig['publication']['replies'];
