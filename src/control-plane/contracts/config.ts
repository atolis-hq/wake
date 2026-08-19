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
        // Exponential backoff base/ceiling for intake's idle-or-erroring
        // poll cadence and the runner's error retry cadence — courtesy
        // toward a rate-limited external API (a per-adapter poll interval,
        // e.g. integrations.github.polling.intervalMs, gates the actual
        // call; this governs how often the resident loop itself re-checks).
        // Unrelated to journal consumption, which waits on
        // JournalChangeSignal instead of polling at all.
        pollBackoffMs: z.number().int().positive().default(1000),
        maxPollBackoffMs: z.number().int().positive().optional(),
      })
      .strict()
      .default({ pollBackoffMs: 1000 }),
  })
  .strict();
