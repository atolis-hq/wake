import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { correlationId } from '../../../src-next/kernel/index.js';
import { FileEventJournal } from '../../../src-next/persistence/index.js';
import { createWorkService } from '../../../src-next/work/index.js';
import { workId } from '../../support/identities.js';
import { FakeClock } from '../support/world.js';

it('E2E-JOURNAL-001 reopens canonical events and continues positions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-restart-'));
  const clock = new FakeClock();
  const id = workId('1');
  const context = {
    commandId: 'create',
    correlationId: correlationId('corr'),
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'operator' as const, id: 'test' },
  };
  await createWorkService(new FileEventJournal(root, clock)).create(
    { workItemId: id, objective: 'ship' },
    context,
  );
  const reopenedJournal = new FileEventJournal(root, clock);
  const reopened = createWorkService(reopenedJournal);
  expect(await reopened.get(id)).toMatchObject({ objective: 'ship' });
  await reopened.revise(
    { workItemId: id, objective: 'ship safely' },
    { ...context, commandId: 'revise' },
  );
  expect((await reopenedJournal.readAll(0)).map((event) => event.globalPosition)).toEqual([1, 2]);
});
