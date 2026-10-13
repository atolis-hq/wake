import type {
  TriggerConfig,
  TriggerInvocationView,
  TriggerSkipDiagnostic,
  TriggerView,
} from '../../../control-plane/index.js';
import type { ValueOf } from '../../../kernel/index.js';

const triggerStatusShape = { enabled: true, paused: true, running: true, removed: true };
const triggerStatuses = Object.keys(triggerStatusShape) as (keyof typeof triggerStatusShape)[];

export const TriggerStatus = {
  Enabled: triggerStatuses[0]!,
  Paused: triggerStatuses[1]!,
  Running: triggerStatuses[2]!,
  Removed: triggerStatuses[3]!,
} as const;

export type TriggerStatus = ValueOf<typeof TriggerStatus>;

export interface TriggerResponse {
  readonly triggerId: string;
  readonly status: TriggerStatus;
  readonly definition: TriggerConfig | null;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly nextOccurrence: string | null;
  readonly pending: readonly TriggerView['coalesced'][string][];
  readonly latestSkip: TriggerSkipDiagnostic | null;
  readonly invocations: readonly (TriggerInvocationView & { readonly workItemKey: string })[];
}
