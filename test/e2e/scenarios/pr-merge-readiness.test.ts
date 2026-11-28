import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProcessorStateStore,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

const github = vi.hoisted(() => ({
  state: 'unstable',
  merged: false,
  attempts: 0,
  failing: false,
}));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    rest = {
      checks: { listForRef() {} },
      repos: {
        getCombinedStatusForRef: async () => ({
          data: {
            statuses: github.failing ? [{ state: 'failure' }] : [],
            total_count: github.failing ? 1 : 0,
          },
          headers: {},
        }),
      },
      pulls: {
        get: async () => ({ data: { node_id: 'PR_1', head: { sha: 'revision-a' } } }),
        merge: async () => {
          github.merged = true;
          return { data: { sha: 'merged-sha' } };
        },
      },
    };

    paginate = {
      iterator: async function* () {
        yield { data: github.failing ? [{ state: 'failure' }] : [], headers: {} };
      },
    };

    graphql = async () => {
      github.attempts++;
      throw new Error('Pull request is in ' + github.state + ' status');
    };
  },
}));

import { MergeMethod } from '../../../src/activities/index.js';
import { createGitHubClient } from '../../../src/integrations/github/infrastructure/client.js';
import { createGitHubDelivery } from '../../../src/integrations/github/infrastructure/delivery.js';
import { DeliveryEventType } from '../../../src/integrations/index.js';
import { workId } from '../../support/identities.js';
import {
  createComposedMergeRoot,
  prepareComposedSafeMerge,
  runComposedDeliveryCycle,
} from './pr-activity-fixtures.js';

const roots = new Set<string>();
afterEach(async () => {
  await Promise.all([...roots].map((path) => rm(path, { recursive: true, force: true })));
  roots.clear();
});

async function fixture() {
  github.failing = false;
  github.state = 'unstable';
  github.merged = false;
  github.attempts = 0;
  let now = new Date('2026-07-30T12:00:00.000Z');
  const clock = { now: () => now };
  const client = createGitHubClient('fake-token');
  const provider = createGitHubDelivery(async () =>
    client.deliver({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      action: 'enable-auto-merge',
      merge_method: MergeMethod.Squash,
      idempotencyKey: 'merge',
    }),
  );
  const options = {
    provider,
    clock,
    autoMerge: true,
    journal: new InMemoryEventJournal(clock),
    projections: new InMemoryProjectionStore(),
    checkpoints: new InMemoryCheckpointStore(),
    processorState: new InMemoryProcessorStateStore(),
  };
  let root = await createComposedMergeRoot(options);
  roots.add(root.paths.wakeRoot);
  const workflowId = await prepareComposedSafeMerge(root);
  return {
    get root() {
      return root;
    },
    workflowId,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    restart: async () => {
      root = await createComposedMergeRoot(options);
      roots.add(root.paths.wakeRoot);
    },
  };
}

it.each([false, true])(
  'recovers unstable GitHub readiness without a later check change (early check event: %s)',
  async (earlyEvent) => {
    const f = await fixture();
    if (earlyEvent) {
      const observed = (await f.root.pullRequests.authorityInput(workId('one'))).pullRequests[0]!;
      await f.root.pullRequests.observe(
        { ...observed, checks: 'pending' },
        {
          commandId: 'early-pending',
          correlationId: 'merge' as never,
          occurredAt: '2026-07-30T12:00:00.000Z',
          actor: { kind: 'system', id: 'test' },
        },
      );
      await f.root.pullRequests.observe(
        { ...observed, checks: 'passing' },
        {
          commandId: 'early-checks',
          correlationId: 'merge' as never,
          occurredAt: '2026-07-30T12:00:00.000Z',
          actor: { kind: 'system', id: 'test' },
        },
      );
    }
    await runComposedDeliveryCycle(f.root);
    expect(github.attempts).toBe(1);
    expect(
      (await f.root.journal.readAll(0)).filter(
        (e) => e.event.eventType === DeliveryEventType.Failed,
      ),
    ).toHaveLength(0);
    await f.restart();
    github.state = 'clean';
    f.advance(59_999);
    await runComposedDeliveryCycle(f.root);
    expect(github.attempts).toBe(1);
    f.advance(1);
    await runComposedDeliveryCycle(f.root);
    expect(github.merged).toBe(true);
    expect((await f.root.orchestration.get(f.workflowId))?.status).toBe('completed');
    expect(
      (await f.root.journal.readAll(0)).filter(
        (e) => e.event.eventType === DeliveryEventType.Failed,
      ),
    ).toHaveLength(0);
  },
);

it('fails persistent instability at the original one-hour bound after restart', async () => {
  const f = await fixture();
  await runComposedDeliveryCycle(f.root);
  f.advance(59 * 60_000);
  await runComposedDeliveryCycle(f.root);
  await f.restart();
  f.advance(60_000);
  await runComposedDeliveryCycle(f.root);
  const facts = await f.root.journal.readAll(0);
  expect(facts.filter((e) => e.event.eventType === DeliveryEventType.Failed)).toHaveLength(1);
  expect(await f.root.orchestration.get(f.workflowId)).toMatchObject({
    status: 'waiting',
    lastOutcome: { kind: 'failed' },
  });
  expect(github.merged).toBe(false);
  expect(facts.filter((e) => e.event.eventType === DeliveryEventType.Deferred)).toHaveLength(2);
});

it('fails a genuine conflict immediately', async () => {
  const f = await fixture();
  github.state = 'dirty';
  await runComposedDeliveryCycle(f.root);
  expect(await f.root.orchestration.get(f.workflowId)).toMatchObject({
    status: 'waiting',
    lastOutcome: { kind: 'failed' },
  });
  expect(
    (await f.root.journal.readAll(0)).some((e) => e.event.eventType === DeliveryEventType.Deferred),
  ).toBe(false);
  expect(github.merged).toBe(false);
});

it('fails genuinely failing checks immediately even when GitHub reports unstable', async () => {
  const f = await fixture();
  github.failing = true;
  await runComposedDeliveryCycle(f.root);
  expect(await f.root.orchestration.get(f.workflowId)).toMatchObject({
    status: 'waiting',
    lastOutcome: { kind: 'failed' },
  });
  expect(
    (await f.root.journal.readAll(0)).some((e) => e.event.eventType === DeliveryEventType.Deferred),
  ).toBe(false);
});
