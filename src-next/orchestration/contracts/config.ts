import { z } from 'zod';

const identifier = z.string().trim().min(1);
const bound = z.object({ max: z.number().int().positive() }).strict();
const actorKind = z.enum(['system', 'operator', 'agent', 'integration']);
const commandName = z.string().regex(/^\/[a-z][a-z0-9-]*$/);
const canonicalEventName = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
const watchStatus = z.enum(['active', 'waiting', 'blocked']);
export const watchConfigSchema = z
  .object({
    id: identifier,
    while: z
      .object({
        stages: z.array(identifier).min(1).readonly(),
        statuses: z.array(watchStatus).min(1).readonly(),
      })
      .strict(),
    on: z
      .object({ events: z.array(canonicalEventName).min(1).readonly() })
      .strict()
      .optional(),
    schedule: z.object({ cron: identifier }).strict().optional(),
    workflow: identifier,
    maxPerGroup: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.on !== undefined || value.schedule !== undefined, {
    message: 'Watch requires on or schedule',
  });
export const followOnActivityConfigSchema = z
  .object({
    use: identifier,
    with: z.unknown().optional(),
  })
  .strict();
export const outcomeRouteConfigSchema = z
  .object({
    activities: z.array(followOnActivityConfigSchema).readonly().optional(),
    then: identifier,
    repeat: bound.optional(),
    retry: bound.optional(),
  })
  .strict();
export const stageConfigSchema = z
  .object({
    activity: identifier,
    with: z.unknown().optional(),
    execution: z
      .object({
        workspace: z.enum(['none', 'read-only', 'branch']).optional(),
        tier: identifier.optional(),
      })
      .strict()
      .optional(),
    on: z
      .record(identifier, outcomeRouteConfigSchema)
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();
export const supplementalCommandConfigSchema = z
  .object({
    activity: identifier,
    with: z.unknown().optional(),
    allowedActors: z.array(actorKind).min(1).readonly(),
  })
  .strict();
export const workflowDefinitionConfigSchema = z
  .object({
    entry: identifier.optional(),
    commands: z.record(commandName, supplementalCommandConfigSchema).optional(),
    watches: z.array(watchConfigSchema).readonly().optional(),
    stages: z
      .record(identifier, stageConfigSchema)
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();

export type FollowOnActivityConfig = z.infer<typeof followOnActivityConfigSchema>;
export type OutcomeRouteConfig = z.infer<typeof outcomeRouteConfigSchema>;
export type StageConfig = z.infer<typeof stageConfigSchema>;
export type SupplementalCommandConfig = z.infer<typeof supplementalCommandConfigSchema>;
export type WatchConfig = z.infer<typeof watchConfigSchema>;
export type WorkflowDefinitionConfig = z.infer<typeof workflowDefinitionConfigSchema>;

export interface CompiledOutcomeRoute extends OutcomeRouteConfig {
  readonly id: string;
  readonly activities?: readonly Readonly<FollowOnActivityConfig>[];
}
export interface CompiledStage extends Omit<StageConfig, 'on'> {
  readonly on: Readonly<Record<string, CompiledOutcomeRoute>>;
}
export interface CompiledSupplementalCommand extends SupplementalCommandConfig {
  readonly allowedActors: readonly ('system' | 'operator' | 'agent' | 'integration')[];
}
export interface CompiledWorkflow {
  readonly name: string;
  readonly entry: string;
  readonly commands: Readonly<Record<string, CompiledSupplementalCommand>>;
  readonly watches: readonly Readonly<WatchConfig>[];
  readonly stages: Readonly<Record<string, CompiledStage>>;
}
