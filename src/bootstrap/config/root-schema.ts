import { z } from 'zod';
import { activitiesConfigSchema, type ActivitiesConfig } from '../../activities/index.js';
import { controlPlaneConfigSchema, type ControlPlaneConfig } from '../../control-plane/index.js';
import { executionConfigSchema, type ExecutionConfig } from '../../execution/index.js';
import { integrationsConfigSchema, type IntegrationsConfig } from '../../integrations/index.js';
import {
  workflowDefinitionConfigSchema,
  workflowSelectorConfigSchema,
} from '../../orchestration/index.js';
import { resourcesConfigSchema, type ResourcesConfig } from '../../resources/index.js';
import { surfacesConfigSchema, type SurfacesConfig } from '../../surfaces/index.js';
import { workConfigSchema, type WorkConfig } from '../../work/index.js';

const orchestrationConfigSchema = z
  .object({
    workflows: z.record(z.string().trim().min(1), workflowDefinitionConfigSchema).default({}),
    workflowSelectors: z.array(workflowSelectorConfigSchema).readonly().default([]),
    default: z.string().trim().min(1).default('default'),
  })
  .strict()
  // Routing may only name a workflow that exists; a root with no workflows configured
  // routes nothing, so its unused fallback is not an error.
  .superRefine((value, ctx) => {
    const configured = new Set(Object.keys(value.workflows));
    if (configured.size > 0 && !configured.has(value.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `default workflow "${value.default}" is not configured in orchestration.workflows`,
      });
    }
    for (const [index, selector] of value.workflowSelectors.entries()) {
      if (configured.has(selector.workflow)) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['workflowSelectors', index, 'workflow'],
        message: `selector workflow "${selector.workflow}" is not configured in orchestration.workflows`,
      });
    }
  })
  .default({
    workflows: {},
    workflowSelectors: [],
    default: 'default',
  });

const transcriptsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    retentionMs: z.number().int().nonnegative().default(86_400_000),
  })
  .strict()
  .default({ enabled: false, retentionMs: 86_400_000 });

const hostConfigSchema = z
  .object({
    sandbox: z
      .object({
        image: z.string().trim().min(1).default('wake-sandbox'),
        imageRepository: z.string().trim().min(1).default('wake-sandbox'),
        containerName: z.string().trim().min(1).default('wake-sandbox'),
        wakeMountPath: z.string().trim().min(1).default('/wake'),
        containerHomeMountPath: z.string().trim().min(1).default('/home/wake'),
        start: z
          .object({ enabled: z.boolean().default(true) })
          .strict()
          .default({ enabled: true }),
        extraMounts: z
          .array(
            z
              .object({
                source: z.string().trim().min(1),
                target: z.string().trim().min(1),
                readOnly: z.boolean().optional(),
              })
              .strict(),
          )
          .readonly()
          .default([]),
      })
      .strict()
      .default({
        image: 'wake-sandbox',
        imageRepository: 'wake-sandbox',
        containerName: 'wake-sandbox',
        wakeMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
        start: { enabled: true },
        extraMounts: [],
      }),
    development: z
      .object({
        repoRoot: z.string().trim().min(1).optional(),
        mode: z.enum(['source', 'packaged']).optional(),
      })
      .strict()
      .default({}),
    selfUpdate: z
      .object({
        drainTimeoutMs: z.number().int().positive().default(30_000),
        cancellationTimeoutMs: z.number().int().positive().default(30_000),
        npm: z
          .object({
            package: z.string().trim().min(1).default('@atolis-hq/wake'),
            distTag: z.string().trim().min(1).default('latest'),
            registry: z.string().url().optional(),
          })
          .strict()
          .default({ package: '@atolis-hq/wake', distTag: 'latest' }),
      })
      .strict()
      .default({
        drainTimeoutMs: 30_000,
        cancellationTimeoutMs: 30_000,
        npm: { package: '@atolis-hq/wake', distTag: 'latest' },
      }),
  })
  .strict()
  .default({
    sandbox: {
      image: 'wake-sandbox',
      imageRepository: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      start: { enabled: true },
      extraMounts: [],
    },
    development: {},
    selfUpdate: {
      drainTimeoutMs: 30_000,
      cancellationTimeoutMs: 30_000,
      npm: { package: '@atolis-hq/wake', distTag: 'latest' },
    },
  })
  .superRefine((value, context) => {
    if (value.development.mode === 'source' && value.development.repoRoot === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['development', 'repoRoot'],
        message: 'source host development requires repoRoot',
      });
  });

export const rootConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    work: workConfigSchema.default({}),
    resources: resourcesConfigSchema.default({}),
    activities: activitiesConfigSchema.default({}),
    orchestration: orchestrationConfigSchema,
    transcripts: transcriptsConfigSchema,
    execution: executionConfigSchema,
    controlPlane: controlPlaneConfigSchema,
    integrations: integrationsConfigSchema,
    surfaces: surfacesConfigSchema,
    host: hostConfigSchema,
  })
  .strict();

export interface ResolvedWakeModulesConfig {
  readonly schemaVersion: 1;
  readonly work: WorkConfig;
  readonly resources: ResourcesConfig;
  readonly activities: ActivitiesConfig;
  readonly orchestration: z.infer<typeof orchestrationConfigSchema>;
  readonly transcripts: z.infer<typeof transcriptsConfigSchema>;
  readonly execution: ExecutionConfig;
  readonly controlPlane: ControlPlaneConfig;
  readonly integrations: IntegrationsConfig;
  readonly surfaces: SurfacesConfig;
  readonly host: z.infer<typeof hostConfigSchema>;
}

export function parseRootConfig(input: unknown): ResolvedWakeModulesConfig {
  return rootConfigSchema.parse(input) as ResolvedWakeModulesConfig;
}
