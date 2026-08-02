import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface UpdateLedger {
  read(): Promise<string | null>;
  begin(tag: string): Promise<void>;
  write(tag: string): Promise<void>;
  recover(): Promise<string | null>;
  isBad(tag: string): Promise<boolean>;
  recordBad(tag: string): Promise<void>;
}

interface UpdateLedgerState {
  readonly lastHealthyTag?: string;
  readonly pendingTag?: string;
  readonly badTags?: readonly string[];
}

export function createUpdateLedger(wakeRoot: string): UpdateLedger {
  const path = join(wakeRoot, '.wake', 'update-ledger.json');
  return {
    async read() {
      return (await readState(path)).lastHealthyTag ?? null;
    },
    async begin(tag) {
      const state = await readState(path);
      await writeState(path, { ...state, pendingTag: tag });
    },
    async write(tag) {
      const state = await readState(path);
      await writeState(path, {
        lastHealthyTag: tag,
        ...(state.badTags === undefined ? {} : { badTags: state.badTags }),
      });
    },
    async isBad(tag) {
      return (await readState(path)).badTags?.includes(tag) ?? false;
    },
    async recordBad(tag) {
      const state = await readState(path);
      await writeState(path, { ...state, badTags: [...new Set([...(state.badTags ?? []), tag])] });
    },
    async recover() {
      const state = await readState(path);
      if (state.pendingTag === undefined) return null;
      await writeState(path, {
        ...(state.lastHealthyTag === undefined ? {} : { lastHealthyTag: state.lastHealthyTag }),
        ...(state.badTags === undefined ? {} : { badTags: state.badTags }),
      });
      return state.lastHealthyTag ?? null;
    },
  };
}

async function readState(path: string): Promise<UpdateLedgerState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof value.lastHealthyTag === 'string' ? { lastHealthyTag: value.lastHealthyTag } : {}),
      ...(typeof value.pendingTag === 'string' ? { pendingTag: value.pendingTag } : {}),
      ...(Array.isArray(value.badTags) && value.badTags.every((tag) => typeof tag === 'string')
        ? { badTags: value.badTags }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function writeState(path: string, state: UpdateLedgerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8');
  await rename(temporary, path);
}
