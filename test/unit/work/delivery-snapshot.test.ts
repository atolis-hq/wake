import { correlationId } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DelegationGate } from '../../../src/orchestration/application/delegation-gate.js';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { createWorkService, type WorkItemId } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const { readdirMock, statMock } = vi.hoisted(() => ({ readdirMock: vi.fn(), statMock: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readdirMock.mockImplementation(actual.readdir);
  statMock.mockImplementation(actual.stat);
  return { ...actual, readdir: readdirMock, stat: statMock };
});

const context = (seed: string) => ({
  commandId: `cmd-${seed}`,
  correlationId: correlationId(`corr-${seed}`),
  occurredAt: '2026-07-30T12:00:00Z',
  actor: { kind: 'operator' as const, id: 'test' },
});

// One segment file per append, as in production, so the listing cost scales with history.
async function seed(root: string, children: number) {
  const clock = new FakeClock();
  const work = createWorkService(new FileEventJournal(root, clock));
  const rootId = workId('root');
  await work.create({ workItemId: rootId, objective: 'root' }, context('root'));
  const ids: WorkItemId[] = [];
  for (let index = 0; index < children; index += 1) {
    const id = workId(`child-${index}`);
    ids.push(id);
    await work.create(
      {
        workItemId: id,
        objective: `child ${index}`,
        delegation: { parentWorkItemId: rootId, rootWorkItemId: rootId, ancestors: [rootId] },
      },
      context(`child-${index}`),
    );
  }
  return { work, rootId, ids };
}

it(
  'answers delivery availability for every item from one synchronisation',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-delivery-snapshot-'));
    const { rootId, ids } = await seed(root, 120);
    const reader = createWorkService(new FileEventJournal(root, new FakeClock()));
    readdirMock.mockClear();
    statMock.mockClear();

    const snapshot = await reader.deliverySnapshot();
    const answers = ids.map((id) => snapshot.availability(id));

    expect(answers.every((answer) => answer.reason === undefined)).toBe(true);
    expect(new Set(answers.map((answer) => answer.rootWorkItemId))).toEqual(new Set([rootId]));
    expect(readdirMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(
      statMock.mock.calls.filter(([path]) => String(path).endsWith('.jsonl')).length,
    ).toBeLessThanOrEqual(2 * 121);
  },
);

it('gates many instances without per-instance journal reads', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-delivery-gate-'));
  const { rootId, ids } = await seed(root, 120);
  const reader = createWorkService(new FileEventJournal(root, new FakeClock()));
  const gate = new DelegationGate({} as never, reader);
  const views = ids.map((workItemId) => ({ workItemId })) as WorkflowInstanceView[];
  readdirMock.mockClear();

  const open = await gate.filterAvailable(views, (view) => view);
  expect(open).toHaveLength(120);
  expect(readdirMock.mock.calls.length).toBeLessThanOrEqual(2);

  // Another host freezes the root; the very next batch sees it without any validity window.
  await createWorkService(new FileEventJournal(root, new FakeClock())).freeze(
    rootId,
    context('freeze'),
  );
  expect(await gate.filterAvailable(views, (view) => view)).toHaveLength(0);
});
