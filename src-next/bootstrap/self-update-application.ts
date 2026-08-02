import { runSelfUpdate } from '../surfaces/index.js';
import type { UpdateLedger } from './update-ledger.js';

export interface SourceUpdatePort {
  isClean(): Promise<boolean>;
  latestTag(): Promise<string>;
  candidateTags(): Promise<readonly string[]>;
  checkout(tag: string): Promise<void>;
  healthy(): Promise<boolean>;
}

export function createSelfUpdateApplication(input: {
  readonly ledger: UpdateLedger;
  readonly source: SourceUpdatePort;
}) {
  return {
    async update(tag: string, force = false): Promise<boolean> {
      await recoverPendingUpdate(input.ledger, input.source);
      if (!force && ((await input.ledger.read()) === tag || (await input.ledger.isBad(tag))))
        return false;
      if (!(await input.source.isClean()))
        throw new Error('Self-update requires a clean source checkout');
      await input.ledger.begin(tag);
      try {
        return await runSelfUpdate({
          tag,
          force: true,
          readLedger: input.ledger.read,
          writeLedger: input.ledger.write,
          update: input.source.checkout,
          health: input.source.healthy,
          rollback: input.source.checkout,
        });
      } catch (error) {
        await input.ledger.recordBad(tag);
        throw error;
      }
    },
    async updateLatest(
      force = false,
    ): Promise<{ readonly tag: string; readonly updated: boolean }> {
      const candidates = await input.source.candidateTags();
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
      // All candidates exhausted or no valid candidates
      if (candidates.length === 0) {
        throw new Error('No source version tags available');
      }
      return { tag: candidates[0], updated: false };
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
