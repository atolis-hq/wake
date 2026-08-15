import { access, appendFile, writeFile } from 'node:fs/promises';
import { acquireFileLock } from '../../../src/persistence/index.js';

const {
  WAKE_LOCK_PATH,
  WAKE_LOCK_READY,
  WAKE_LOCK_GO,
  WAKE_LOCK_DONE,
  WAKE_LOCK_WINNERS,
  WAKE_LOCK_RELEASE,
} = process.env;
if (
  !WAKE_LOCK_PATH ||
  !WAKE_LOCK_READY ||
  !WAKE_LOCK_GO ||
  !WAKE_LOCK_DONE ||
  !WAKE_LOCK_WINNERS ||
  !WAKE_LOCK_RELEASE
)
  throw new Error('File-lock contender environment is incomplete');

await writeFile(WAKE_LOCK_READY, 'ready\n');
await waitFor(WAKE_LOCK_GO);
const lock = await acquireFileLock(WAKE_LOCK_PATH, {
  now: new Date(61_000),
  staleAfterMs: 60_000,
  staleRequiresDeadProcess: true,
  isProcessAlive: () => false,
});
if (lock.acquired) await appendFile(WAKE_LOCK_WINNERS, `${process.pid}\n`);
await writeFile(WAKE_LOCK_DONE, 'done\n');
if (lock.acquired) {
  await waitFor(WAKE_LOCK_RELEASE);
  await lock.release();
}

async function waitFor(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
}
