export interface ScheduleConfig {
  readonly id: string;
  readonly workflow: string;
  readonly cron: string;
  readonly objective: string;
}

export interface ControlPlaneConfig {
  readonly maxDispatches: number;
  readonly maxConcurrentRuns: number;
  readonly schedules: readonly ScheduleConfig[];
  readonly resident?: { readonly pollBackoffMs: number; readonly maxPollBackoffMs?: number };
}

import { z } from 'zod';

const scheduleSchema = z
  .object({
    id: z.string().trim().min(1),
    workflow: z.string().trim().min(1),
    cron: z.string().trim().min(1),
    objective: z.string().trim().min(1),
  })
  .strict();

export const controlPlaneConfigSchema = z
  .object({
    maxDispatches: z.number().int().positive().default(1),
    maxConcurrentRuns: z.number().int().positive().default(1),
    schedules: z.array(scheduleSchema).default([]),
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
    schedules: [],
    resident: { pollBackoffMs: 1000 },
  });
