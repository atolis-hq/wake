import { z } from 'zod';

import {
  TriggerFinishedStatusValue,
  TriggerRequestDispositionValue,
  TriggerSkipReasonValue,
  TriggerSourceKindValue,
} from '../../../api/contracts/transport-values.js';

export {
  TriggerRequestDispositionValue as TriggerRequestDisposition,
  TriggerFinishedStatusValue as WorkflowStatus,
};

export const triggerSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(TriggerSourceKindValue.Cron), slot: z.string() }),
  z.object({
    kind: z.literal(TriggerSourceKindValue.Event),
    eventId: z.string(),
    eventType: z.string(),
  }),
]);

export const triggerSkipDiagnosticSchema = z.object({
  triggerId: z.string(),
  source: triggerSourceSchema,
  occurredAt: z.string(),
  reason: z.enum(TriggerSkipReasonValue),
});
const trigger = z.object({
  id: z.string(),
  workflow: z.string(),
  contextScope: z.string().optional(),
  on: z.object({ cron: z.string().optional(), events: z.array(z.string()).optional() }),
  when: z.object({ capacityAvailable: z.literal(true) }).optional(),
});

export const triggerDefinitionSchema = trigger;
