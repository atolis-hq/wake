import { z } from 'zod';

export const executionConfigSchema = z
  .object({
    runners: z
      .record(z.string().trim().min(1), z.object({ kind: z.string().trim().min(1) }).strict())
      .default({}),
    tiers: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)).default({}),
    defaultTier: z.string().trim().min(1),
    leaseDurationMs: z.number().int().positive().optional(),
    leaseRenewalIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

export interface ExecutionConfig {
  readonly tiers: Readonly<Record<string, readonly string[]>>;
  readonly defaultTier: string;
  readonly leaseDurationMs?: number;
  readonly leaseRenewalIntervalMs?: number;
}
