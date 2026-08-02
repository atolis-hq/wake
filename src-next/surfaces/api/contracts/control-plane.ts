import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';
import type { ResourceResponse } from './common.js';

export interface ControlPlaneStatusResponse {
  readonly paused: boolean;
  readonly pausedUntil?: string;
  readonly reason?: string;
  readonly updatedAt: string;
}

export interface AcceptedCommandResponse {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: string;
  readonly status: ApiCommandStatus;
}

export interface TickCommandResponse extends AcceptedCommandResponse {
  readonly result: ResourceResponse<ControlPlaneStatusResponse>;
}

export interface CommandConflictResponse {
  readonly conflict: true;
  readonly code: string;
  readonly detail?: string;
  readonly retryable?: boolean;
  readonly current?: unknown;
}

export type ApiCommandResult = AcceptedCommandResponse | CommandConflictResponse;

export type ApiTickCommandResult = TickCommandResponse | CommandConflictResponse;

export const ApiCommandStatus = defineClosedVocabulary({
  Accepted: 'accepted',
  Completed: 'completed',
} as const);

export type ApiCommandStatus = ValueOf<typeof ApiCommandStatus>;
