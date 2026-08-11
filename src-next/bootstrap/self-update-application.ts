import { runSelfUpdate } from '../surfaces/index.js';
import type { UpdateLedger } from './update-ledger.js';
import { UpdateMaintenancePhase } from './update-maintenance-lease.js';

export interface SourceUpdatePort {
  isClean(): Promise<boolean>;
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
  acquire(tag: string): Promise<void>;
  activeRuns(): Promise<
    readonly { readonly runId: string; readonly maintenanceCancellable: boolean }[]
  >;
  requestMaintenanceCancellation(runIds: readonly string[]): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  fail(error: unknown): Promise<void>;
  transition(
    phase: Exclude<UpdateMaintenancePhase, typeof UpdateMaintenancePhase.Failed>,
  ): Promise<void>;
  clear(): Promise<void>;
}

export function createSelfUpdateApplication(input: {
  readonly ledger: UpdateLedger;
  readonly source: SourceUpdatePort;
  readonly rollout?: SelfUpdateRolloutPort;
  readonly quiesce?: SelfUpdateQuiescePort;
  readonly drainTimeoutMs?: number;
  readonly cancellationTimeoutMs?: number;
}) {
  return {
    // The operational update sequence deliberately keeps each failure boundary explicit.
    // eslint-disable-next-line complexity
    async update(tag: string, force = false): Promise<boolean> {
      await input.quiesce?.acquire(tag);
      let deployError: unknown;
      // A failed deploy surfaces as a failed health check (not a thrown
      // update) so it goes through runSelfUpdate's existing rollback path,
      // which only triggers on health() returning false.
      try {
        if (input.quiesce !== undefined)
          await quiesceActiveRuns(
            input.quiesce,
            input.drainTimeoutMs ?? 30_000,
            input.cancellationTimeoutMs ?? 30_000,
          );
        await recoverPendingUpdate(input.ledger, input.source);
        if (!force && ((await input.ledger.read()) === tag || (await input.ledger.isBad(tag)))) {
          await input.quiesce?.clear();
          return false;
        }
        if (!(await input.source.isClean()))
          throw new Error('Self-update requires a clean source checkout');
        await input.ledger.begin(tag);
        await input.quiesce?.transition(UpdateMaintenancePhase.Updating);
        const updated = await runSelfUpdate({
          tag,
          force: true,
          readLedger: input.ledger.read,
          writeLedger: input.ledger.write,
          update: async (nextTag) => {
            await input.source.checkout(nextTag);
            if (input.rollout === undefined) return;
            try {
              await input.rollout.deploy(nextTag);
            } catch (error) {
              deployError = error;
            }
          },
          health: async () => {
            if (deployError !== undefined) return false;
            return input.source.healthy();
          },
          rollback: async (priorTag) => {
            await input.quiesce?.transition(UpdateMaintenancePhase.RollingBack);
            await input.source.checkout(priorTag);
            await input.rollout?.rollback(priorTag);
          },
        });
        await input.quiesce?.clear();
        return updated;
      } catch (error) {
        try {
          await input.quiesce?.fail(error);
        } catch (persistenceError) {
          await input.ledger.recordBad(tag);
          throw new Error(
            `Could not persist failed maintenance lease: ${formatError(persistenceError)}. ` +
              `Quiesce remains unresolved: ${formatError(error)}`,
            { cause: persistenceError },
          );
        }
        if (input.rollout !== undefined) {
          try {
            await input.rollout.recordFailure(tag, deployError ?? error);
          } catch {
            // Best-effort: a failure-log write must never mask the original update failure.
          }
        }
        await input.ledger.recordBad(tag);
        throw error;
      }
    },
    async updateLatest(
      force = false,
    ): Promise<{ readonly tag: string; readonly updated: boolean }> {
      const candidates = await input.source.candidateTags();
      const [latestCandidate] = candidates;
      if (latestCandidate === undefined) {
        throw new Error('No source version tags available');
      }
      for (const tag of candidates) {
        if (!force && (await input.ledger.isBad(tag))) {
          continue;
        }
        const updated = await this.update(tag, force);
        if (updated) {
          return { tag, updated: true };
        }
        // If update returned false (same tag or skipped), try the next candidate
        if (!force && (await input.ledger.read()) === tag) {
          // Already on this tag, no need to try others
          return { tag, updated: false };
        }
      }
      // All candidates exhausted
      return { tag: latestCandidate, updated: false };
    },
  };
}

async function quiesceActiveRuns(
  quiesce: SelfUpdateQuiescePort,
  drainTimeoutMs: number,
  cancellationTimeoutMs: number,
): Promise<void> {
  let remaining = await waitForActiveRunsToDrain(quiesce, drainTimeoutMs);
  if (remaining.length === 0) return;

  await quiesce.requestMaintenanceCancellation(
    remaining.filter((run) => run.maintenanceCancellable).map((run) => run.runId),
  );
  remaining = await waitForActiveRunsToDrain(quiesce, cancellationTimeoutMs);
  if (remaining.length === 0) return;

  throw new Error(
    `active Runs remain after maintenance cancellation: ${remaining.map((run) => run.runId).join(', ')}`,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForActiveRunsToDrain(
  quiesce: SelfUpdateQuiescePort,
  timeoutMs: number,
): Promise<readonly { readonly runId: string; readonly maintenanceCancellable: boolean }[]> {
  const deadline = quiesce.now() + timeoutMs;
  let activeRuns = await quiesce.activeRuns();
  while (activeRuns.length > 0 && quiesce.now() < deadline) {
    await quiesce.sleep(Math.min(100, deadline - quiesce.now()));
    activeRuns = await quiesce.activeRuns();
  }
  return activeRuns;
}

async function recoverPendingUpdate(ledger: UpdateLedger, source: SourceUpdatePort): Promise<void> {
  const priorTag = await ledger.recover();
  if (priorTag === null) return;
  await source.checkout(priorTag);
  if (!(await source.healthy()))
    throw new Error(`Self-update recovery could not verify the prior tag ${priorTag}`);
}
