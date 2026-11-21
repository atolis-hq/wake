import { z } from 'zod';
import type { ValueOf } from '../../kernel/index.js';

export const TriggerSkipReason = {
  TriggerOriginated: 'trigger-originated',
  Paused: 'paused',
  Removed: 'removed',
  DispatchPaused: 'dispatch-paused',
  Capacity: 'capacity-unavailable',
  PendingLimit: 'pending-source-limit',
} as const;

export type TriggerSkipReason = ValueOf<typeof TriggerSkipReason>;

/** Journal history may hold the pre-rename `own-scope` value; read it as the new reason. */
export const legacyOwnScopeReason = 'own-scope';

export const triggerSkipReasonSchema = z.preprocess(
  (value) => (value === legacyOwnScopeReason ? TriggerSkipReason.TriggerOriginated : value),
  z.enum(TriggerSkipReason),
);
