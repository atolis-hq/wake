import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { createAdvanceOnce } from '../../../src/control-plane/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const MARKERS = 20;
const context = (seed: string) => ({
  commandId: `cmd-${seed}`,
  correlationId: `corr-${seed}` as never,
  occurredAt: '2026-07-30T12:00:00Z',
  actor: { kind: 'operator' as const, id: 'test' },
});

async function setup() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const ids = Array.from({ length: MARKERS }, (_, index) => workId(`item-${index}`));
  for (const id of ids) await work.create({ workItemId: id, objective: 'ship' }, context(id));
  let retained: boolean[] = [];
  const advance = createAdvanceOnce(
    {
      reconcileChildCompletions: async () => undefined,
      listPendingActivations: async () => [],
      listWaiting: async () => [],
      acceptOutcome: async () => {
        throw new Error('unexpected');
      },
      markActivationStarted: async () => {
        throw new Error('unexpected');
      },
    },
    {
      attempt: async () => {
        throw new Error('unexpected');
      },
      list: async () => [],
    },
    { correlationsForWork: async () => [] } as never,
    { now: () => new Date('2026-08-11T00:00:00.000Z') },
    {
      ids: { next: () => 'command-00000000000000000000000001' } as never,
      work,
      workspaceRecovery: {
        recover: async (_runs, options) => {
          retained = [];
          for (const id of ids)
            retained.push((await options?.retainWorkItem?.(id as never)) === true);
          return { reclaimed: 0, failures: [] };
        },
      },
    },
  );
  const readStream = vi.spyOn(journal, 'readStream');
  const readAll = vi.spyOn(journal, 'readAll');
  const pass = async () => {
    readStream.mockClear();
    readAll.mockClear();
    await advance({ maxProgress: 1 });
    return { streams: readStream.mock.calls.length, all: readAll.mock.calls.length };
  };
  return { work, ids, pass, retained: () => retained };
}

it('answers per-marker retention from memory once the snapshot is current', async () => {
  const { pass, retained } = await setup();
  await pass();
  expect(retained().every(Boolean)).toBe(true);
  for (let i = 0; i < 3; i += 1) expect(await pass()).toEqual({ streams: 0, all: 0 });
});

it('observes closed and deleted work on the next pass', async () => {
  const { work, ids, pass, retained } = await setup();
  await pass();
  await work.close(ids[0]!, 'done', context('close'));
  await work.delete(ids[1]!, context('delete'));
  expect((await pass()).streams).toBe(0);
  expect(retained().slice(0, 3)).toEqual([false, false, true]);
});
