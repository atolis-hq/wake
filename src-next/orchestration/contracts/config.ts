import { z } from 'zod';

const identifier = z.string().trim().min(1);
const bound = z.object({ max: z.number().int().positive() }).strict();
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
export const workflowDefinitionConfigSchema = z
  .object({
    entry: identifier.optional(),
    stages: z
      .record(identifier, stageConfigSchema)
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();

export type FollowOnActivityConfig = z.infer<typeof followOnActivityConfigSchema>;
export type OutcomeRouteConfig = z.infer<typeof outcomeRouteConfigSchema>;
export type StageConfig = z.infer<typeof stageConfigSchema>;
export type WorkflowDefinitionConfig = z.infer<typeof workflowDefinitionConfigSchema>;

export interface CompiledOutcomeRoute extends OutcomeRouteConfig {
  readonly id: string;
  readonly activities?: readonly Readonly<FollowOnActivityConfig>[];
}
export interface CompiledStage extends Omit<StageConfig, 'on'> {
  readonly on: Readonly<Record<string, CompiledOutcomeRoute>>;
}
export interface CompiledWorkflow {
  readonly name: string;
  readonly entry: string;
  readonly stages: Readonly<Record<string, CompiledStage>>;
}
