import type { ValueOf } from '../../kernel/index.js';

export const TriggerSkipReason = {
  OwnScope: 'own-scope',
  Paused: 'paused',
  Removed: 'removed',
  DispatchPaused: 'dispatch-paused',
  Capacity: 'capacity-unavailable',
  PendingLimit: 'pending-source-limit',
} as const;

export type TriggerSkipReason = ValueOf<typeof TriggerSkipReason>;
