import type {
  TriggerConfig,
  TriggerInvocationView,
  TriggerSkipDiagnostic,
  TriggerView,
} from '../../../control-plane/index.js';
import type { ValueOf } from '../../../kernel/index.js';
import type { WorkflowStatus } from '../../../orchestration/index.js';

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
  readonly operatorInstructions?: {
    readonly contextScope: string;
    readonly revisionId: string;
    readonly content: string;
    readonly author: string;
    readonly occurredAt: string;
  } | null;
  readonly activeInvocation: {
    readonly activeWorkItemId: string;
    readonly workItemKey: string;
    readonly triggerId: string;
    readonly workflowInstanceId: string;
    readonly workflowStatus: WorkflowStatus | null;
    readonly blockReason: string | null;
    readonly retryEligible: boolean;
  } | null;
  readonly triggerId: string;
  readonly status: TriggerStatus;
  readonly definition: TriggerConfig | null;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly nextOccurrence: string | null;
  readonly pending: readonly (Omit<
    TriggerView['coalesced'][string],
    'manualRequests' | 'automaticRequests'
  > & {
    readonly activeWorkItemId: string | null;
  })[];
  readonly latestSkip: TriggerSkipDiagnostic | null;
  readonly invocations: readonly (TriggerInvocationView & { readonly workItemKey: string })[];
}

export interface OrphanedInstructionsResponse {
  readonly contextScope: string;
  readonly revisionId: string;
  readonly content: string | null;
  readonly author: string;
  readonly occurredAt: string;
}

const triggerCommandShape = { pause: true, resume: true, run: true };
const triggerCommands = Object.keys(triggerCommandShape) as (keyof typeof triggerCommandShape)[];

export const TriggerCommandName = {
  Pause: triggerCommands[0]!,
  Resume: triggerCommands[1]!,
  Run: triggerCommands[2]!,
} as const;

export type TriggerCommandName = ValueOf<typeof TriggerCommandName>;
