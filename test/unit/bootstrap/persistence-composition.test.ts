import { expect, it } from 'vitest';
import { resolveWakePaths } from '../../../src/bootstrap/index.js';
import { composePersistence } from '../../../src/bootstrap/persistence-composition.js';
import type { EventJournal } from '../../../src/kernel/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('serializes appends shared by resident runtime loops', async () => {
  const journal = concurrentAppendRejectingJournal();
  const persistence = composePersistence(resolveWakePaths('C:/wake-home'), new FakeClock(), {
    journal,
  });

  await expect(
    Promise.all([
      persistence.journal.append({} as never, 0, []),
      persistence.journal.append({} as never, 0, []),
    ]),
  ).resolves.toEqual([[], []]);
});

function concurrentAppendRejectingJournal(): EventJournal {
  let appendInFlight = false;
  return {
    async append() {
      if (appendInFlight) throw new Error('concurrent append');
      appendInFlight = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      appendInFlight = false;
      return [];
    },
    async readStream() {
      return [];
    },
    async readAll() {
      return [];
    },
  };
}
