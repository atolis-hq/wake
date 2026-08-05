import { runSelfUpdate } from '../surfaces/index.js';
import type { UpdateLedger } from './update-ledger.js';

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

export function createSelfUpdateApplication(input: {
  readonly ledger: UpdateLedger;
  readonly source: SourceUpdatePort;
  readonly rollout?: SelfUpdateRolloutPort;
}) {
  return {
    async update(tag: string, force = false): Promise<boolean> {
      await recoverPendingUpdate(input.ledger, input.source);
      if (!force && ((await input.ledger.read()) === tag || (await input.ledger.isBad(tag))))
        return false;
      if (!(await input.source.isClean()))
        throw new Error('Self-update requires a clean source checkout');
      await input.ledger.begin(tag);
      // A failed deploy surfaces as a failed health check (not a thrown
      // update) so it goes through runSelfUpdate's existing rollback path,
      // which only triggers on health() returning false.
      let deployError: unknown;
      try {
        return await runSelfUpdate({
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
            await input.source.checkout(priorTag);
            await input.rollout?.rollback(priorTag);
          },
        });
      } catch (error) {
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

async function recoverPendingUpdate(ledger: UpdateLedger, source: SourceUpdatePort): Promise<void> {
  const priorTag = await ledger.recover();
  if (priorTag === null) return;
  await source.checkout(priorTag);
  if (!(await source.healthy()))
    throw new Error(`Self-update recovery could not verify the prior tag ${priorTag}`);
}
