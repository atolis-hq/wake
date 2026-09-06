import { runSelfUpdate } from '../surfaces/index.js';
import type { UpdateLedger } from './update-ledger.js';
import { UpdateMaintenancePhase, type UpdateMaintenanceState } from './update-maintenance-lease.js';

export interface SourceUpdatePort {
  isClean(): Promise<boolean>;
  /** The version currently running before any update starts, when available. */
  currentTag?(): Promise<string | null>;
  latestTag(): Promise<string>;
  candidateTags(): Promise<readonly string[]>;
  checkout(tag: string): Promise<void>;
  healthy(): Promise<boolean>;
}

/**
 * Optional Docker rollout alongside the source checkout — build+swap the
 * sandbox container onto the new tag, roll it back on a failed deploy, and
 * best-effort record the failure for the operator health screen. Absent for
 * non-sandbox self-updates.
 */
export interface SelfUpdateRolloutPort {
  deploy(tag: string): Promise<void>;
  rollback(tag: string): Promise<void>;
  recordFailure(tag: string, error: unknown): Promise<void>;
}

/**
 * Coordinates the update's maintenance window with the running Control Plane.
 * `acquire` must durably block dispatch before the first active-run read, and
 * activeRuns must include every active or ambiguous Run. Cancellation must
 * durably record every supplied Run's maintenance request.
 */
export interface SelfUpdateQuiescePort {
  acquire(tag: string, retryFailed?: boolean): Promise<UpdateMaintenanceState>;
  exclusive?<Value>(
    tag: string,
    retryFailed: boolean,
    operation: (state: UpdateMaintenanceState) => Promise<Value>,
  ): Promise<Value>;
  activeRuns(): Promise<
    readonly { readonly runId: string; readonly maintenanceCancellable: boolean }[]
  >;
  /** @deprecated Active Runs are never cancelled for maintenance. */
  requestMaintenanceCancellation?(runIds: readonly string[]): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  fail(error: unknown, attemptId?: string): Promise<void>;
  transition(
    phase: Exclude<UpdateMaintenancePhase, typeof UpdateMaintenancePhase.Failed>,
    attemptId?: string,
  ): Promise<void>;
  clear(attemptId?: string): Promise<void>;
}

export function createSelfUpdateApplication(input: {
  readonly ledger: UpdateLedger;
  readonly source: SourceUpdatePort;
  readonly rollout?: SelfUpdateRolloutPort;
  readonly quiesce?: SelfUpdateQuiescePort;
  /** @deprecated Draining is unbounded so active work can finish normally. */
  readonly drainTimeoutMs?: number;
  /** @deprecated Active work is never cancelled for maintenance. */
  readonly cancellationTimeoutMs?: number;
}) {
  return {
    async update(tag: string, force = false): Promise<boolean> {
      if (!force && (await input.ledger.isBad(tag))) return false;
      if (!force && !(await isLaterCandidate(input, tag))) return false;
      return startUpdateAttempt(input, tag, force);
    },
    async updateLatest(
      force = false,
    ): Promise<{ readonly tag: string; readonly updated: boolean }> {
      const candidates = await input.source.candidateTags();
      const [latestCandidate] = candidates;
      if (latestCandidate === undefined) throw new Error('No update versions are available');
      const current = await currentTag(input);
      const currentIndex = current === null ? -1 : candidates.indexOf(current);
      // Candidates are newest-first. The current healthy tag is a hard
      // boundary: never enter maintenance to reapply or downgrade from it.
      const laterCandidates = currentIndex === -1 ? candidates : candidates.slice(0, currentIndex);
      for (const tag of laterCandidates) {
        if (!force && (await input.ledger.isBad(tag))) {
          continue;
        }
        let updated: boolean;
        try {
          // `laterCandidates` already established this tag is newer than the
          // current version, so do not rediscover candidates for each attempt.
          updated = await startUpdateAttempt(input, tag, force);
        } catch (error) {
          if (error instanceof UpdateCandidateFailure) continue;
          throw error;
        }
        if (updated) {
          return { tag, updated: true };
        }
      }
      return { tag: latestCandidate, updated: false };
    },
  };
}

async function isLaterCandidate(
  input: Parameters<typeof createSelfUpdateApplication>[0],
  tag: string,
): Promise<boolean> {
  const candidates = await input.source.candidateTags();
  const candidateIndex = candidates.indexOf(tag);
  if (candidateIndex === -1) return false;
  const current = await currentTag(input);
  if (current === null) return candidateIndex === 0;
  const currentIndex = candidates.indexOf(current);
  if (currentIndex === -1) return candidateIndex === 0;
  return candidateIndex < currentIndex;
}

async function currentTag(
  input: Parameters<typeof createSelfUpdateApplication>[0],
): Promise<string | null> {
  return (await input.source.currentTag?.()) ?? (await input.ledger.read());
}

async function startUpdateAttempt(
  input: Parameters<typeof createSelfUpdateApplication>[0],
  tag: string,
  force: boolean,
): Promise<boolean> {
  if (input.quiesce?.exclusive !== undefined)
    return input.quiesce.exclusive(tag, force, (lease) => updateAttempt(input, tag, force, lease));
  return updateAttempt(input, tag, force, await input.quiesce?.acquire(tag, force));
}

async function updateAttempt(
  input: Parameters<typeof createSelfUpdateApplication>[0],
  tag: string,
  force: boolean,
  lease: UpdateMaintenanceState | undefined,
): Promise<boolean> {
  const maintenanceTag = lease?.tag ?? tag;
  const attemptId = lease?.attemptId;
  const context: UpdateAttemptContext = {};
  try {
    return await performUpdateAttempt(input, tag, force, lease, context);
  } catch (error) {
    await recordUpdateFailure(
      input,
      maintenanceTag,
      attemptId,
      context.deployError ?? error,
      error,
    );
    throw error;
  }
}

interface UpdateAttemptContext {
  deployError?: unknown;
}

async function performUpdateAttempt(
  input: Parameters<typeof createSelfUpdateApplication>[0],
  tag: string,
  force: boolean,
  lease: UpdateMaintenanceState | undefined,
  context: UpdateAttemptContext,
): Promise<boolean> {
  if (lease !== undefined && requiresMaintenanceRecovery(lease)) {
    await resumePendingMaintenance(input, lease);
    return false;
  }
  if (!isStartableMaintenanceLease(lease, tag)) return false;
  await quiesceForUpdate(input);
  await recoverPendingUpdate(input.ledger, input.source);
  if (!force && (await input.ledger.read()) === tag) {
    await input.quiesce?.clear(lease?.attemptId);
    return false;
  }
  return runForwardUpdate(input, tag, lease?.attemptId, context);
}

function requiresMaintenanceRecovery(lease: UpdateMaintenanceState): boolean {
  return (
    lease.phase !== UpdateMaintenancePhase.Quiescing &&
    lease.phase !== UpdateMaintenancePhase.Failed
  );
}

function isStartableMaintenanceLease(
  lease: UpdateMaintenanceState | undefined,
  tag: string,
): boolean {
  return (
    lease === undefined || (lease.phase === UpdateMaintenancePhase.Quiescing && lease.tag === tag)
  );
}

async function quiesceForUpdate(
  input: Parameters<typeof createSelfUpdateApplication>[0],
): Promise<void> {
  if (input.quiesce === undefined) return;
  await quiesceActiveRuns(input.quiesce);
}

async function runForwardUpdate(
  input: Parameters<typeof createSelfUpdateApplication>[0],
  tag: string,
  attemptId: string | undefined,
  context: UpdateAttemptContext,
): Promise<boolean> {
  if (!(await input.source.isClean()))
    throw new Error('Self-update requires a clean source checkout');
  await input.ledger.begin(tag);
  await input.quiesce?.transition(UpdateMaintenancePhase.Updating, attemptId);
  let rollbackSucceeded = false;
  let updated: boolean;
  try {
    updated = await runSelfUpdate({
      tag,
      force: true,
      readLedger: input.ledger.read,
      writeLedger: input.ledger.write,
      update: async (nextTag) => {
        await input.source.checkout(nextTag);
        context.deployError = await deployRollout(input.rollout, nextTag);
      },
      health: async () => context.deployError === undefined && input.source.healthy(),
      rollback: async (priorTag) => {
        await rollbackUpdate(input, priorTag, attemptId);
        rollbackSucceeded = true;
      },
    });
  } catch (error) {
    if (!rollbackSucceeded) throw new UpdateRollbackError(error);
    throw new UpdateCandidateFailure(error);
  }
  await input.quiesce?.clear(attemptId);
  return updated;
}

class UpdateRollbackError extends Error {
  constructor(error: unknown) {
    super(formatError(error), { cause: error });
    this.name = 'UpdateRollbackError';
  }
}

class UpdateCandidateFailure extends Error {
  constructor(error: unknown) {
    super(formatError(error), { cause: error });
    this.name = 'UpdateCandidateFailure';
  }
}

async function deployRollout(
  rollout: SelfUpdateRolloutPort | undefined,
  tag: string,
): Promise<unknown> {
  if (rollout === undefined) return undefined;
  try {
    await rollout.deploy(tag);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function rollbackUpdate(
  input: Parameters<typeof createSelfUpdateApplication>[0],
  priorTag: string,
  attemptId: string | undefined,
): Promise<void> {
  await input.quiesce?.transition(UpdateMaintenancePhase.RollingBack, attemptId);
  await input.source.checkout(priorTag);
  await input.rollout?.rollback(priorTag);
}

async function recordUpdateFailure(
  input: Parameters<typeof createSelfUpdateApplication>[0],
  tag: string,
  attemptId: string | undefined,
  rolloutError: unknown,
  originalError: unknown,
): Promise<void> {
  try {
    await input.quiesce?.fail(originalError, attemptId);
  } catch (persistenceError) {
    await input.ledger.recordBad(tag);
    throw new Error(
      `Could not persist failed maintenance lease: ${formatError(persistenceError)}. ` +
        `Quiesce remains unresolved: ${formatError(originalError)}`,
      { cause: persistenceError },
    );
  }
  await recordRolloutFailure(input.rollout, tag, rolloutError);
  await input.ledger.recordBad(tag);
}

async function recordRolloutFailure(
  rollout: SelfUpdateRolloutPort | undefined,
  tag: string,
  error: unknown,
): Promise<void> {
  if (rollout === undefined) return;
  try {
    await rollout.recordFailure(tag, error);
  } catch {
    // Best-effort: a failure-log write must never mask the original update failure.
  }
}

/**
 * A restart must never repeat a forward deploy. The persisted phase tells us
 * that source/rollout work may already have begun, so recover the prior
 * healthy revision while the durable lease continues to pause the runtime.
 */
async function resumePendingMaintenance(
  input: {
    readonly ledger: UpdateLedger;
    readonly source: SourceUpdatePort;
    readonly rollout?: SelfUpdateRolloutPort;
    readonly quiesce?: SelfUpdateQuiescePort;
  },
  lease: UpdateMaintenanceState,
): Promise<void> {
  if (lease.phase === UpdateMaintenancePhase.Quiescing) return;
  const priorTag = await input.ledger.recover();
  if (priorTag === null)
    throw new Error(`Self-update recovery has no prior healthy tag for ${lease.tag}`);
  await input.source.checkout(priorTag);
  await input.rollout?.rollback(priorTag);
  if (!(await input.source.healthy()))
    throw new Error(`Self-update recovery could not verify the prior tag ${priorTag}`);
  await input.ledger.recordBad(lease.tag);
  await input.quiesce?.clear(lease.attemptId);
}

async function quiesceActiveRuns(quiesce: SelfUpdateQuiescePort): Promise<void> {
  while ((await quiesce.activeRuns()).length > 0) {
    await quiesce.sleep(100);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recoverPendingUpdate(ledger: UpdateLedger, source: SourceUpdatePort): Promise<void> {
  const priorTag = await ledger.recover();
  if (priorTag === null) return;
  await source.checkout(priorTag);
  if (!(await source.healthy()))
    throw new Error(`Self-update recovery could not verify the prior tag ${priorTag}`);
}
