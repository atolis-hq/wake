import type { RunStatus } from './vocabulary.js';
import { WorkspaceMode } from '../../activities/index.js';
import type { ActivityOutcome } from '../../activities/index.js';
import type { RunId } from './identifiers.js';
export type RunTransportStatus = RunStatus;
export interface RunView {
  readonly runId: RunId;
  readonly activationId: string;
  readonly activity: string;
  readonly attempt: number;
  readonly status: RunTransportStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome?: ActivityOutcome;
  readonly failure?: { readonly kind: string; readonly message: string };
  readonly workspace?: {
    readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
    readonly path: string;
  };
}
