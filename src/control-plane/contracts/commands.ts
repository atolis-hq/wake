import { ExecutionCancellationReason } from '../../execution/index.js';
import { WorkflowStatus } from '../../orchestration/index.js';
import type { AdvanceOptions, AdvanceResult } from './views.js';

export const HostStopReason = {
  Idle: 'idle',
  Waiting: WorkflowStatus.Waiting,
  Blocked: WorkflowStatus.Blocked,
  Budget: 'budget',
  Paused: 'paused',
  Shutdown: ExecutionCancellationReason.Shutdown,
} as const;

export interface HostBudget {
  readonly maxAdvances: number;
  readonly maxRuns: number;
  readonly maxDurationMs: number;
}

export interface HostResult {
  readonly advances: number;
  readonly runs: number;
  readonly stoppedBecause:
    | 'idle'
    | typeof HostStopReason.Waiting
    | typeof HostStopReason.Blocked
    | 'budget'
    | 'paused'
    | typeof HostStopReason.Shutdown;
}

export type AdvanceOnce = (options: AdvanceOptions, signal?: AbortSignal) => Promise<AdvanceResult>;

/** Optional scheduler phases used by hosts that can make several dispatch attempts in one pass. */
export interface AdvancePhases {
  maintain(signal?: AbortSignal): Promise<MaintenanceResult>;
  dispatch(options: AdvanceOptions, signal?: AbortSignal): Promise<AdvanceResult>;
}

export type MaintenanceResult = { readonly kind: 'ready' | 'paused' };

export type PhasedAdvanceOnce = AdvanceOnce & Partial<AdvancePhases>;
