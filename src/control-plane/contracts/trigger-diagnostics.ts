import { z } from 'zod';
import type { ValueOf } from '../../kernel/index.js';
import { triggerSourceSchema } from './events.js';

export const TriggerSkipReason = {
  OwnScope: 'own-scope',
  Paused: 'paused',
  Removed: 'removed',
  DispatchPaused: 'dispatch-paused',
  Capacity: 'capacity-unavailable',
  PendingLimit: 'pending-source-limit',
} as const;

export type TriggerSkipReason = ValueOf<typeof TriggerSkipReason>;

export const triggerSkipDiagnosticSchema = z
  .object({
    triggerId: z.string().min(1),
    source: triggerSourceSchema,
    occurredAt: z.string().datetime({ offset: true }),
    reason: z.enum(TriggerSkipReason),
  })
  .strict();

export type TriggerSkipDiagnostic = z.infer<typeof triggerSkipDiagnosticSchema>;

// Operational diagnostics are bounded processor state, not occurrence history.
export const maximumTriggerDiagnostics = 256;

export const triggerDiagnosticsSchema = z
  .array(triggerSkipDiagnosticSchema)
  .max(maximumTriggerDiagnostics);
