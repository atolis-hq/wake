import { readJsonFile, writeJsonFile } from '../../lib/json-file.js';

export type SelfUpdateLedger = {
  lastAppliedTag: string | null;
  lastKnownGoodTag: string | null;
  badTags: Array<{ tag: string; reason: string; recordedAt: string }>;
};

const EMPTY_LEDGER: SelfUpdateLedger = {
  lastAppliedTag: null,
  lastKnownGoodTag: null,
  badTags: [],
};

export async function readSelfUpdateLedger(path: string): Promise<SelfUpdateLedger> {
  try {
    return await readJsonFile<SelfUpdateLedger>(path);
  } catch {
    return EMPTY_LEDGER;
  }
}

export async function writeSelfUpdateLedger(path: string, ledger: SelfUpdateLedger): Promise<void> {
  await writeJsonFile(path, ledger);
}
