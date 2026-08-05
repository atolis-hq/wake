export interface ScheduleConfig {
  readonly id: string;
  readonly workflow: string;
  readonly cron: string;
  readonly objective: string;
}

export interface ControlPlaneConfig {
  readonly maxDispatches: number;
  readonly schedules: readonly ScheduleConfig[];
  readonly resident?: { readonly idleBackoffMs: number; readonly maxIdleBackoffMs?: number };
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
    schedules: z.array(scheduleSchema).default([]),
    resident: z
      .object({
        idleBackoffMs: z.number().int().positive().default(1000),
        maxIdleBackoffMs: z.number().int().positive().optional(),
      })
      .strict()
      .default({ idleBackoffMs: 1000 }),
  })
  .strict();
