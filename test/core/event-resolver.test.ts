import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createEventResolver } from '../../src/core/event-resolver.js';
import { UNRESOLVED_WORK_ITEM_KEY } from '../../src/domain/schema.js';
import { createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';
import { isWorkId } from '../../src/lib/work-id.js';

const clock = { now: () => new Date('2026-07-05T12:05:00.000Z') };

function issueUri(issueNumber: number): string {
  return `github:issue:atolis-hq/wake#${issueNumber}`;
}

function ticketUpsert(issueNumber: number) {
  const nowIso = '2026-07-05T12:00:00.000Z';
  return createUnkeyedEventEnvelope({
    eventId: `ticket-upsert-${issueNumber}`,
    streamScope: 'global-intake',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: 'ticket.upsert',
    sourceRefs: {
      repo: 'atolis-hq/wake',
      issueNumber,
      sourceUrl: `https://example.test/issues/${issueNumber}`,
      resourceUri: issueUri(issueNumber),
    },
    occurredAt: nowIso,
    ingestedAt: nowIso,
    trigger: 'immediate',
    payload: {
      ticket: {
        repo: 'atolis-hq/wake',
        number: issueNumber,
        title: 'Ticket',
        body: 'Body',
        labels: ['wake'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: `https://example.test/issues/${issueNumber}`,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    },
  });
}

describe('event resolver', () => {
  let root: string;
  let store: ReturnType<typeof createStateStore>;
  let resourceIndex: ReturnType<typeof createFakeResourceIndex>;

  function resolver(qualifiesForMint: () => boolean) {
    const projectionUpdater = createProjectionUpdater({
      stateStore: store,
      resourceIndex,
      config: createDefaultWakeConfig(root),
    });
    return createEventResolver({
      clock,
      config: createDefaultWakeConfig(root),
      stateStore: store,
      resourceIndex,
      projectionUpdater,
      qualifiesForMint,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-resolver-'));
    store = createStateStore({ wakeRoot: root });
    resourceIndex = createFakeResourceIndex();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('mints a work item and registers its origin resource on a miss', async () => {
    await resolver(() => true).ingestInboundEvents([ticketUpsert(1)]);

    const owner = await resourceIndex.resolve(issueUri(1));
    expect(owner).toBeDefined();
    expect(isWorkId(owner as string)).toBe(true);

    const projections = await store.listIssueStates();
    expect(projections).toHaveLength(1);
    const minted = projections[0]!;
    expect(minted.workItemKey).toBe(owner);
    expect(minted.correlatedResources.map((r) => r.resourceUri)).toContain(issueUri(1));
  });

  it('does not mint when the event does not qualify', async () => {
    await resolver(() => false).ingestInboundEvents([ticketUpsert(2)]);

    expect(await resourceIndex.resolve(issueUri(2))).toBeUndefined();
    const persisted = await store.readEventEnvelope('ticket-upsert-2');
    expect(persisted?.workItemKey).toBe(UNRESOLVED_WORK_ITEM_KEY);
  });

  it('resolves to the existing work item instead of minting a duplicate', async () => {
    await resourceIndex.register(issueUri(3), 'work-01JZ0000000000000000000003');

    await resolver(() => true).ingestInboundEvents([ticketUpsert(3)]);

    const projections = await store.listIssueStates();
    expect(projections).toHaveLength(1);
    expect(projections[0]!.workItemKey).toBe('work-01JZ0000000000000000000003');
    const persisted = await store.readEventEnvelope('ticket-upsert-3');
    expect(persisted?.workItemKey).toBe('work-01JZ0000000000000000000003');
  });

  it('throws when an unkeyed event carries no resourceUri', async () => {
    const badEvent = createUnkeyedEventEnvelope({
      eventId: 'no-uri',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 4 },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:00.000Z',
      trigger: 'immediate',
      payload: {},
    });

    await expect(resolver(() => true).ingestInboundEvents([badEvent])).rejects.toThrow(
      /resourceUri is required/,
    );
  });
});
