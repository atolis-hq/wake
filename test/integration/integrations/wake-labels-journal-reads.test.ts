import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { createGitHubWakeLabelReconciler } from '../../../src/integrations/github/index.js';
import {
  BuiltInResourceCapability,
  BuiltInResourceKind,
  ResourceCorrelationRole,
} from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';

const ITEMS = 20;
const context = (seed: string) => ({
  commandId: `cmd-${seed}`,
  correlationId: `corr-${seed}` as never,
  occurredAt: '2026-07-30T12:00:00Z',
  actor: { kind: 'integration' as const, id: 'github' },
});

async function setup() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const { resources } = createTestResourceServices(journal);
  const items = Array.from({ length: ITEMS }, (_, index) => ({
    work: workId(`item-${index}`),
    resource: resId(`resource-${index}`),
    issue: index + 1,
  }));
  const link = async (item: (typeof items)[number]) => {
    await resources.discover(
      {
        resourceId: item.resource,
        kind: BuiltInResourceKind.Issue,
        externalKey: { adapter: 'github', key: `org/repo#${item.issue}` },
        capabilities: [BuiltInResourceCapability.Commentable],
      },
      context(`discover-${item.issue}`),
    );
    await resources.correlate(
      item.resource,
      item.work,
      ResourceCorrelationRole.Primary,
      context(`correlate-${item.issue}`),
    );
  };
  for (const item of items) {
    await work.create({ workItemId: item.work, objective: 'ship' }, context(`work-${item.issue}`));
    await link(item);
  }
  const labelled: number[] = [];
  const workflows = () =>
    items.map((item) => ({
      workflowInstanceId: `wf-${item.issue}`,
      workItemId: item.work,
      workflowName: 'default',
      status: 'active',
      currentStage: 'implement',
    }));
  const reconciler = createGitHubWakeLabelReconciler({
    orchestration: { listAll: async () => workflows() as never },
    resources,
    work,
    getLabels: async () => [],
    setLabels: async (_owner, _repo, number) => {
      labelled.push(number);
    },
  });
  const readStream = vi.spyOn(journal, 'readStream');
  const readAll = vi.spyOn(journal, 'readAll');
  const reads = async () => {
    readStream.mockClear();
    readAll.mockClear();
    await reconciler.runOnce();
    return { streams: readStream.mock.calls.length, all: readAll.mock.calls.length };
  };
  return { journal, work, resources, items, labelled, reconciler, reads, link };
}

it('answers repeated passes over open items without loading any stream', async () => {
  const { reads, labelled } = await setup();

  await reads();
  expect(labelled).toHaveLength(ITEMS);
  for (let pass = 0; pass < 3; pass += 1) expect(await reads()).toEqual({ streams: 0, all: 0 });
});

it('observes a closed item on the next pass without re-syncing it', async () => {
  const { reads, work, items, labelled } = await setup();
  await reads();
  labelled.length = 0;
  await work.close(items[0]!.work, 'done', context('close'));
  await reads();
  expect(await reads()).toEqual({ streams: 0, all: 0 });
  expect(labelled).toEqual([]);
});

it('observes a cancelled item on the next pass and stays quiet afterwards', async () => {
  const { reads, work, items, labelled } = await setup();
  await reads();
  labelled.length = 0;
  await work.cancel(items[1]!.work, 'gone', context('cancel'));
  expect(await reads()).toEqual({ streams: 0, all: 2 });
  expect(labelled).toEqual([]);
  expect(await reads()).toEqual({ streams: 0, all: 0 });
});

it('observes a newly added correlation on the next pass', async () => {
  const { reads, work, items, labelled, link } = await setup();
  await reads();
  labelled.length = 0;
  const added = { work: workId('late'), resource: resId('late-resource'), issue: 99 };
  await work.create({ workItemId: added.work, objective: 'late' }, context('late'));
  items.push(added);
  await link(added);
  await reads();
  expect(labelled).toEqual([99]);
  expect(await reads()).toEqual({ streams: 0, all: 0 });
});

it('stops labelling a resource once its primary correlation is retracted', async () => {
  const { reads, resources, items, labelled } = await setup();
  await reads();
  labelled.length = 0;
  // Moving the primary to another work item makes the original no longer the owner.
  await resources.retract(items[2]!.resource, items[2]!.work, context('retract'));
  await reads();
  expect(labelled).toEqual([]);
  expect(await reads()).toEqual({ streams: 0, all: 0 });
});
