import { z } from 'zod';
import { artifactSharedContextNameSchema } from '../../artifacts/index.js';
import { CronTriggerPolicy } from '../domain/cron-trigger-policy.js';

export interface TriggerConfig {
  readonly id: string;
  readonly workflow: string;
  readonly contextScope?: string;
  readonly on: { readonly events?: readonly string[]; readonly cron?: string };
  readonly when?: { readonly capacityAvailable: true };
}

export interface ControlPlaneConfig {
  readonly maxDispatches: number;
  readonly maxConcurrentRuns: number;
  readonly maxOpenWorkItems?: number | null;
  readonly triggers: readonly TriggerConfig[];
  readonly resident?: { readonly pollBackoffMs: number; readonly maxPollBackoffMs?: number };
}

const triggerSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .refine((id) => !/[\\/]/.test(id), 'Trigger id must not contain path separators'),
    workflow: z.string().trim().min(1),
    contextScope: artifactSharedContextNameSchema.optional(),
    on: z
      .object({
        events: z.array(z.string().trim().min(1)).min(1).optional(),
        cron: z
          .string()
          .trim()
          .min(1)
          .superRefine((cron, context) => {
            try {
              new CronTriggerPolicy().elapsedSlots(
                { id: 'validation', cron },
                '2026-01-01T00:00:00.000Z',
                null,
              );
            } catch (error) {
              context.addIssue({
                code: 'custom',
                message: error instanceof Error ? error.message : 'Invalid cron',
              });
            }
          })
          .optional(),
      })
      .strict()
      .refine(
        (on) => on.events !== undefined || on.cron !== undefined,
        'At least one trigger source is required',
      ),
    when: z
      .object({ capacityAvailable: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict();

export const controlPlaneConfigSchema = z
  .object({
    maxDispatches: z.number().int().positive().default(1),
    maxConcurrentRuns: z.number().int().positive().default(1),
    maxOpenWorkItems: z.number().int().positive().nullable().default(null),
    triggers: z.array(triggerSchema).default([]),
    resident: z
      .object({
        // Backoff for the resident loop's own retry cadence when idle or
        // erroring, not a per-adapter rate limit (e.g.
        // integrations.github.polling.intervalMs gates the actual call).
        pollBackoffMs: z.number().int().positive().default(1000),
        maxPollBackoffMs: z.number().int().positive().optional(),
      })
      .strict()
      .default({ pollBackoffMs: 1000 }),
  })
  .strict()
  .default({
    maxDispatches: 1,
    maxConcurrentRuns: 1,
    maxOpenWorkItems: null,
    triggers: [],
    resident: { pollBackoffMs: 1000 },
  });

export function artifactContextCoordinationKey(contextScope: string): string {
  return `context:${contextScope}`;
}
