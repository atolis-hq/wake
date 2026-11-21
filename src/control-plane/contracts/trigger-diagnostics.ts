import { z } from 'zod';
import { triggerSourceSchema } from './events.js';

import { triggerSkipReasonSchema } from './trigger-skip-reason.js';

export { TriggerSkipReason } from './trigger-skip-reason.js';

export const triggerSkipDiagnosticSchema = z
  .object({
    triggerId: z.string().min(1),
    source: triggerSourceSchema,
    occurredAt: z.string().datetime({ offset: true }),
    reason: triggerSkipReasonSchema,
  })
  .strict();

export type TriggerSkipDiagnostic = z.infer<typeof triggerSkipDiagnosticSchema>;

// Operational diagnostics are bounded processor state, not occurrence history.
export const maximumTriggerDiagnostics = 256;

export const triggerDiagnosticsSchema = z
  .array(triggerSkipDiagnosticSchema)
  .max(maximumTriggerDiagnostics);
