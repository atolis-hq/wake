import { beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeArtifactVerifier } from '../../src/adapters/fake/fake-artifact-verifier.js';
import { createFakeGitHubPullRequestActivitySource } from '../../src/adapters/fake/fake-github-pull-request-activity-source.js';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createResourceIndex } from '../../src/adapters/fs/resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createOutboundSinkRouter, createWorkSourceFanIn } from '../../src/core/sink-router.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import {
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  CORRELATION_REGISTERED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from '../../src/domain/schema.js';
import type { EventEnvelope, IssueStateRecord } from '../../src/domain/types.js';
import { createEventEnvelope, createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';
import { isWorkId } from '../../src/lib/work-id.js';
import {
  findByIssueRef,
  githubIssueUri,
  seededResourceIndex,
  ticketUpsertWorkSource,
  workId,
} from './support/tick-runner-fixtures.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  describe('replay & durable-state invariants', () => {
    it('round 3: the auto-registration survives rm -rf state/ + replay when the source polls after the tick started (ADR 0001 rebuild guarantee)', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createResourceIndex({ paths: store.paths });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const tickRunner = createTickRunner({
        // The tick captures `nowIso` at 12:00:00, before it polls; the work
        // source stamps its upsert at poll time, 12:00:01. This is the real
        // production relationship (pollEvents runs after tickStartedAt is
        // captured), and it is what every other fixture hides by pinning both
        // clocks to the same instant.
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        resourceIndex,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 62,
              title: 'Replay the origin registration',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
          now: () => new Date('2026-07-05T12:00:01.000Z'),
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const before = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 62 });
      expect(before?.correlatedResources).toEqual([
        expect.objectContaining({
          resourceUri: 'fake-ticketing:issue:atolis-hq/wake#62',
          role: 'representation',
          relation: 'primary',
          provenance: 'wake-created',
        }),
      ]);
      // The work id is minted, so it is read off the projection, never spelled out.
      const workItemKey = before?.workItemKey ?? '';
      expect(isWorkId(workItemKey)).toBe(true);
      expect(await resourceIndex.resolve('fake-ticketing:issue:atolis-hq/wake#62')).toBe(
        workItemKey,
      );

      // state/ (projection AND index) is a rebuildable cache over events/.
      await rm(join(root, 'state'), { recursive: true, force: true });
      await createProjectionUpdater({ stateStore: store, resourceIndex }).rebuildFromEvents(
        await store.listEventEnvelopes(),
      );

      // If the registration were stamped with the tick's own `nowIso` it would
      // sort before the 12:00:01 upsert that creates the projection, fold
      // against `current === null`, and be silently dropped — leaving these two
      // assertions empty/undefined while the registration event still on record
      // stops any later tick from re-registering it. Permanent, silent loss.
      const after = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 62 });
      expect(after?.correlatedResources).toEqual(before?.correlatedResources);
      // Replay reproduces the *same* work id, because identity lives in the
      // events, not in state/.
      expect(after?.workItemKey).toBe(workItemKey);
      expect(await resourceIndex.resolve('fake-ticketing:issue:atolis-hq/wake#62')).toBe(
        workItemKey,
      );

      // And the mechanism that makes the above hold: the registration is stamped
      // max(origin upsert's ingestedAt, tick's nowIso), never the tick's nowIso
      // alone, so it can never sort ahead of the upsert it depends on.
      expect(before?.correlatedResources[0]?.registeredAt).toBe('2026-07-05T12:00:01.000Z');
    });

    it('a tick that both discovers and dispatches an item survives rm -rf state/ + replay under an advancing clock (ADR 0001 rebuild guarantee)', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createResourceIndex({ paths: store.paths });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      // A *sequenced* clock, not a frozen one. Every other fixture in this file
      // pins the tick clock and the source clock to the same instant, which makes
      // every event in the tick tie on ingestedAt — and a tie is invisible here,
      // because the sort in rebuildFromEvents is stable and therefore silently
      // preserves append order, making replay accidentally correct. Only a clock
      // that advances across calls reproduces the production relationship: the
      // tick's own reads straddle pollEvents(), which stamps at 12:00:01.
      //   1st read  (tick start / decision clock) -> 12:00:00
      //   poll                                     -> 12:00:01 (source's clock)
      //   every later read (event stamping)        -> 12:00:02, 12:00:03, ...
      const clockBaseMs = Date.parse('2026-07-05T12:00:00.000Z');
      let clockReads = 0;
      const sequencedClock = {
        now: () => {
          const offsetMs = clockReads === 0 ? 0 : (clockReads + 1) * 1000;
          clockReads += 1;
          return new Date(clockBaseMs + offsetMs);
        },
      };

      const tickRunner = createTickRunner({
        clock: sequencedClock,
        config,
        stateStore: store,
        resourceIndex,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 63,
              title: 'Discover and dispatch in one tick',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
          now: () => new Date('2026-07-05T12:00:01.000Z'),
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const before = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 63 });
      expect(before?.wake.stageHistory.map((entry) => entry.reason)).toContain(
        'run:refine:claimed',
      );

      // state/ is a rebuildable cache over events/ — nothing more.
      await rm(join(root, 'state'), { recursive: true, force: true });
      await createProjectionUpdater({ stateStore: store, resourceIndex }).rebuildFromEvents(
        await store.listEventEnvelopes(),
      );
      const after = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 63 });

      // Every event this tick stamps must be dated when it actually happened, so
      // none of them can sort ahead of the poll-time upsert that creates the
      // projection they fold into. An event stamped from a frozen tick-start
      // snapshot folds against `current === null` on replay and is silently
      // discarded, costing the replayed projection its claimed stageHistory
      // entry and recentEventIds — a divergence from the live fold.
      expect(after?.wake.stageHistory).toEqual(before?.wake.stageHistory);
      expect(after?.wake.lastRunId).toBe(before?.wake.lastRunId);
      expect(after?.context).toEqual(before?.context);
      expect(after).toEqual(before);
    });

    it('reproduces projections and the resource index exactly after deleting state/ and replaying events/ (ADR 0001 rebuild guarantee)', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createResourceIndex({ paths: store.paths });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        resourceIndex,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 70,
              title: 'Rebuild target',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
          // Pinned to the tick clock deliberately, and this test must stay that
          // way while its `clock` is frozen. This tick clock returns 12:00:00 on
          // every read, so `eventStampNow()` cannot advance past the poll the way
          // a real clock does; polling at 12:00:01 would sort every Wake-stamped
          // event before the upsert that creates the projection and drop them on
          // replay — a frozen-clock artifact, not a production defect.
          //
          // The cost is that this fixture cannot see ordering bugs: equal
          // timestamps tie, the stable sort keeps append order, and replay comes
          // out right for the wrong reason. That blind spot is why three separate
          // ordering bugs survived here. It is covered instead by the dedicated
          // rebuild test above, which drives a *sequenced* clock (tick 12:00:00,
          // poll 12:00:01, stamping 12:00:02+) and is the fixture to extend if
          // you are testing ordering. This one proves projection equivalence for
          // a rich projection; that one proves ordering.
          now: () => new Date('2026-07-05T12:00:00.000Z'),
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      // First tick mints the work item, registering the origin ticket as its
      // primary representation.
      await tickRunner.runTick();

      // Minted, so it is read back off the projection rather than spelled out.
      const mintedWorkItemKey =
        (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 70 }))?.workItemKey ??
        '';
      expect(isWorkId(mintedWorkItemKey)).toBe(true);

      // Simulate additional correlated resources being discovered (e.g. an
      // implementation PR) via the same fold + index machinery a later
      // `wake correlate` command will drive, sharing the exact stateStore +
      // resourceIndex instances the tick runner uses.
      const projectionUpdater = createProjectionUpdater({ stateStore: store, resourceIndex });
      const prRegistration = createEventEnvelope({
        eventId: 'wake-70-pr-registered',
        workItemKey: mintedWorkItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: CORRELATION_REGISTERED_EVENT,
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 70,
          resourceUri: 'github:pr:atolis-hq/wake#71',
        },
        occurredAt: '2026-07-05T12:05:00.000Z',
        ingestedAt: '2026-07-05T12:05:00.000Z',
        trigger: 'context-only',
        payload: {
          resourceUri: 'github:pr:atolis-hq/wake#71',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        },
      });
      await store.appendEventEnvelope(prRegistration);
      await projectionUpdater.rebuildFromEvents([prRegistration]);

      // A second, unrelated work item now shows up and tries to claim the same
      // PR as its own primary — this must fold to a *real* secondary (a
      // registration on a uri another work item already holds as primary),
      // never an orphan one, and must record a primary-conflict event naming
      // the incumbent (ADR 0001 §6). This is also the conflict path that
      // appends an event mid-fold, which is exactly where replay divergence
      // would hide, so the rebuild guarantee below must hold across it too.
      const secondIssueUpsert = createEventEnvelope({
        eventId: 'fake-issue-atolis-hq-wake-90',
        workItemKey: workId(90),
        streamScope: 'global-intake',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.upsert',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 90,
          resourceUri: 'fake-ticketing:issue:atolis-hq/wake#90',
        },
        occurredAt: '2026-07-05T12:07:00.000Z',
        ingestedAt: '2026-07-05T12:07:00.000Z',
        trigger: 'immediate',
        payload: {
          issue: {
            repo: 'atolis-hq/wake',
            number: 90,
            title: 'Conflicting claimant',
            body: 'Body',
            labels: ['wake:queue'],
            assignees: [],
            state: 'open',
            url: 'https://example.test/atolis-hq/wake/issues/90',
            createdAt: '2026-07-05T12:07:00.000Z',
            updatedAt: '2026-07-05T12:07:00.000Z',
          },
        },
      });
      const conflictingRegistration = createEventEnvelope({
        eventId: 'wake-90-pr-conflict-registered',
        workItemKey: workId(90),
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: CORRELATION_REGISTERED_EVENT,
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 90,
          resourceUri: 'github:pr:atolis-hq/wake#71',
        },
        occurredAt: '2026-07-05T12:08:00.000Z',
        ingestedAt: '2026-07-05T12:08:00.000Z',
        trigger: 'context-only',
        payload: {
          resourceUri: 'github:pr:atolis-hq/wake#71',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        },
      });

      for (const event of [secondIssueUpsert, conflictingRegistration]) {
        await store.appendEventEnvelope(event);
        await projectionUpdater.rebuildFromEvents([event]);
      }

      // A third and fourth work item whose *creation* order and *registration*
      // order disagree — the fixture that catches grouped-by-workItemKey
      // rebuild ordering bugs, which the #70/#90 pair above does not (there,
      // creation order and registration order happen to agree). Work item
      // #100 is created first (12:10) but registers the shared uri *second*
      // (12:30); work item #101 is created second (12:15) but registers the
      // shared uri *first* (12:20). Live/incremental folding (in true
      // chronological order, one event at a time, exactly as below) must make
      // #101 the primary (it registered first) and #100 the secondary with a
      // primary-conflict event naming #101 as incumbent. A rebuild that groups
      // by workItemKey and folds group-by-group in Map insertion order would
      // instead process #100's group to completion first (its earliest event,
      // the 12:10 creation, appears first in the overall event array), making
      // #100 the primary — silently disagreeing with the live result.
      const thirdIssueUpsert = createEventEnvelope({
        eventId: 'fake-issue-atolis-hq-wake-100',
        workItemKey: workId(100),
        streamScope: 'global-intake',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.upsert',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 100,
          resourceUri: 'fake-ticketing:issue:atolis-hq/wake#100',
        },
        occurredAt: '2026-07-05T12:10:00.000Z',
        ingestedAt: '2026-07-05T12:10:00.000Z',
        trigger: 'immediate',
        payload: {
          issue: {
            repo: 'atolis-hq/wake',
            number: 100,
            title: 'Created first, registers second',
            body: 'Body',
            labels: ['wake:queue'],
            assignees: [],
            state: 'open',
            url: 'https://example.test/atolis-hq/wake/issues/100',
            createdAt: '2026-07-05T12:10:00.000Z',
            updatedAt: '2026-07-05T12:10:00.000Z',
          },
        },
      });
      const fourthIssueUpsert = createEventEnvelope({
        eventId: 'fake-issue-atolis-hq-wake-101',
        workItemKey: workId(101),
        streamScope: 'global-intake',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.upsert',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 101,
          resourceUri: 'fake-ticketing:issue:atolis-hq/wake#101',
        },
        occurredAt: '2026-07-05T12:15:00.000Z',
        ingestedAt: '2026-07-05T12:15:00.000Z',
        trigger: 'immediate',
        payload: {
          issue: {
            repo: 'atolis-hq/wake',
            number: 101,
            title: 'Created second, registers first',
            body: 'Body',
            labels: ['wake:queue'],
            assignees: [],
            state: 'open',
            url: 'https://example.test/atolis-hq/wake/issues/101',
            createdAt: '2026-07-05T12:15:00.000Z',
            updatedAt: '2026-07-05T12:15:00.000Z',
          },
        },
      });
      const fourthWorkItemRegistersFirst = createEventEnvelope({
        eventId: 'wake-101-shared-registered',
        workItemKey: workId(101),
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: CORRELATION_REGISTERED_EVENT,
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 101,
          resourceUri: 'github:pr:atolis-hq/wake#72',
        },
        occurredAt: '2026-07-05T12:20:00.000Z',
        ingestedAt: '2026-07-05T12:20:00.000Z',
        trigger: 'context-only',
        payload: {
          resourceUri: 'github:pr:atolis-hq/wake#72',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        },
      });
      const thirdWorkItemRegistersSecond = createEventEnvelope({
        eventId: 'wake-100-shared-registered',
        workItemKey: workId(100),
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: CORRELATION_REGISTERED_EVENT,
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 100,
          resourceUri: 'github:pr:atolis-hq/wake#72',
        },
        occurredAt: '2026-07-05T12:30:00.000Z',
        ingestedAt: '2026-07-05T12:30:00.000Z',
        trigger: 'context-only',
        payload: {
          resourceUri: 'github:pr:atolis-hq/wake#72',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        },
      });

      // Fold strictly in chronological (ingestedAt) order, one event at a
      // time, exactly like the live/incremental tick path does — this is the
      // "before" ground truth the rebuild must reproduce.
      for (const event of [
        thirdIssueUpsert,
        fourthIssueUpsert,
        fourthWorkItemRegistersFirst,
        thirdWorkItemRegistersSecond,
      ]) {
        await store.appendEventEnvelope(event);
        await projectionUpdater.rebuildFromEvents([event]);
      }

      const beforeCreatedFirst = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 100,
      });
      const beforeCreatedSecond = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 101,
      });
      expect(beforeCreatedSecond?.correlatedResources).toEqual([
        {
          resourceUri: 'github:pr:atolis-hq/wake#72',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
          registeredAt: '2026-07-05T12:20:00.000Z',
        },
      ]);
      expect(beforeCreatedFirst?.correlatedResources).toEqual([
        {
          resourceUri: 'github:pr:atolis-hq/wake#72',
          role: 'implementation',
          relation: 'secondary',
          provenance: 'agent-reported',
          registeredAt: '2026-07-05T12:30:00.000Z',
        },
      ]);
      expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#72')).toBe(workId(101));

      const disagreeingOrderConflictEventBefore = (await store.listEventEnvelopes()).find(
        (event) =>
          event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT &&
          (event.payload as { resourceUri?: string }).resourceUri === 'github:pr:atolis-hq/wake#72',
      );
      expect(disagreeingOrderConflictEventBefore?.eventId).toBe(
        'wake-100-shared-registered-primary-conflict',
      );

      const beforeIncumbent = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 70,
      });
      expect(beforeIncumbent?.correlatedResources.length ?? 0).toBeGreaterThanOrEqual(2);

      const beforeClaimant = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 90,
      });
      expect(beforeClaimant?.correlatedResources).toEqual([
        {
          resourceUri: 'github:pr:atolis-hq/wake#71',
          role: 'implementation',
          relation: 'secondary',
          provenance: 'agent-reported',
          registeredAt: '2026-07-05T12:08:00.000Z',
        },
      ]);
      expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#71')).toBe(mintedWorkItemKey);

      const beforeAllEvents = await store.listEventEnvelopes();
      const conflictEventCountBefore = beforeAllEvents.filter(
        (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT,
      ).length;
      expect(conflictEventCountBefore).toBe(2);

      const indexDir = join(root, 'state', 'index');
      const shardFilesBefore = (await readdir(indexDir)).sort();
      expect(shardFilesBefore.length).toBeGreaterThanOrEqual(1);
      const shardSnapshots = new Map<string, string>();
      for (const file of shardFilesBefore) {
        shardSnapshots.set(file, await readFile(join(indexDir, file), 'utf8'));
      }

      // Delete state/ entirely — the projection AND the index are both
      // rebuildable projections over events/, never source of truth.
      await rm(join(root, 'state'), { recursive: true, force: true });

      const allEvents = await store.listEventEnvelopes();
      await projectionUpdater.rebuildFromEvents(allEvents);

      const afterIncumbent = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 70,
      });
      expect(afterIncumbent).toEqual(beforeIncumbent);

      const afterClaimant = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 90,
      });
      expect(afterClaimant).toEqual(beforeClaimant);

      // The disagreeing-order pair: replay must reproduce the *live* winner
      // (#101, who registered first chronologically), not whichever work item
      // a workItemKey-grouped rebuild happened to visit first.
      const afterCreatedFirst = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 100,
      });
      expect(afterCreatedFirst).toEqual(beforeCreatedFirst);

      const afterCreatedSecond = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 101,
      });
      expect(afterCreatedSecond).toEqual(beforeCreatedSecond);

      expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#72')).toBe(workId(101));

      const disagreeingOrderConflictEventAfter = (await store.listEventEnvelopes()).find(
        (event) =>
          event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT &&
          (event.payload as { resourceUri?: string }).resourceUri === 'github:pr:atolis-hq/wake#72',
      );
      expect(disagreeingOrderConflictEventAfter?.eventId).toBe(
        disagreeingOrderConflictEventBefore?.eventId,
      );

      const shardFilesAfter = (await readdir(indexDir)).sort();
      expect(shardFilesAfter).toEqual(shardFilesBefore);
      for (const file of shardFilesAfter) {
        expect(await readFile(join(indexDir, file), 'utf8')).toBe(shardSnapshots.get(file));
      }

      const afterAllEvents = await store.listEventEnvelopes();
      const conflictEventCountAfter = afterAllEvents.filter(
        (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT,
      ).length;
      expect(conflictEventCountAfter).toBe(conflictEventCountBefore);
    });
  });
});
