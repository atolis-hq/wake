import { z } from 'zod';
import { activitiesConfigSchema, type ActivitiesConfig } from '../../activities/index.js';
import { executionConfigSchema, type ExecutionConfig } from '../../execution/index.js';
import { integrationsConfigSchema, type IntegrationsConfig } from '../../integrations/index.js';
import { workflowDefinitionConfigSchema } from '../../orchestration/index.js';
import { workConfigSchema, type WorkConfig } from '../../work/index.js';
import { resourcesConfigSchema, type ResourcesConfig } from '../../resources/index.js';
import { surfacesConfigSchema, type SurfacesConfig } from '../../surfaces/index.js';
import { controlPlaneConfigSchema, type ControlPlaneConfig } from '../../control-plane/index.js';

const orchestrationConfigSchema = z
  .object({
    workflows: z.record(z.string().trim().min(1), workflowDefinitionConfigSchema).default({}),
  })
  .strict()
  .default({ workflows: {} });

export const rootConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    work: workConfigSchema.default({}),
    resources: resourcesConfigSchema.default({}),
    activities: activitiesConfigSchema.default({}),
    orchestration: orchestrationConfigSchema,
    execution: executionConfigSchema,
    controlPlane: controlPlaneConfigSchema,
    integrations: integrationsConfigSchema,
    surfaces: surfacesConfigSchema,
  })
  .strict();

export interface ResolvedWakeModulesConfig {
  readonly schemaVersion: 1;
  readonly work: WorkConfig;
  readonly resources: ResourcesConfig;
  readonly activities: ActivitiesConfig;
  readonly orchestration: z.infer<typeof orchestrationConfigSchema>;
  readonly execution: ExecutionConfig;
  readonly controlPlane: ControlPlaneConfig;
  readonly integrations: IntegrationsConfig;
  readonly surfaces: SurfacesConfig;
}

export function parseRootConfig(input: unknown): ResolvedWakeModulesConfig {
  return rootConfigSchema.parse(input) as ResolvedWakeModulesConfig;
}
