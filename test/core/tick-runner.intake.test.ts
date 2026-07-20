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

  describe('intake & correlation/mint', () => {
    it('derives the watchlist from correlatedResources and passes it to pollEvents', async () => {
      const store = createStateStore({ wakeRoot: root });
      const pollEvents = vi.fn().mockResolvedValue([]);

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(91),
        issue: {
          repo: 'atolis-hq/wake',
          number: 91,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/91',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'implement',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
        correlatedResources: [
          {
            resourceUri: 'github:pr:org/repo#91',
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: '2026-07-05T12:00:00.000Z',
          },
        ],
      });

      const config = createDefaultWakeConfig(root);

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: { pollEvents },
        outboundSink: {
          async deliverIntent() {
            return [];
          },
        },
        runner: {
          async run() {
            throw new Error('should not run');
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      expect(pollEvents).toHaveBeenCalledWith({
        watch: expect.arrayContaining([{ resourceUri: 'github:pr:org/repo#91' }]),
      });
    });

    it('passes every correlated resourceUri through to pollEvents verbatim, deduplicated, without interpreting them', async () => {
      const store = createStateStore({ wakeRoot: root });
      const pollEvents = vi.fn().mockResolvedValue([]);

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(91),
        issue: {
          repo: 'atolis-hq/wake',
          number: 91,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/91',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'implement',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
        correlatedResources: [
          {
            resourceUri: 'github:issue:org/repo#91',
            role: 'representation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: '2026-07-05T12:00:00.000Z',
          },
          {
            resourceUri: 'github:pr:org/repo#91',
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: '2026-07-05T12:00:00.000Z',
          },
          {
            resourceUri: 'github:pr-review-thread:org/repo#91/rt_501',
            role: 'implementation',
            relation: 'secondary',
            provenance: 'agent-reported',
            registeredAt: '2026-07-05T12:00:00.000Z',
          },
        ],
      });

      const config = createDefaultWakeConfig(root);

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: { pollEvents },
        outboundSink: {
          async deliverIntent() {
            return [];
          },
        },
        runner: {
          async run() {
            throw new Error('should not run');
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      expect(pollEvents).toHaveBeenCalledWith({
        watch: [
          { resourceUri: 'github:issue:org/repo#91' },
          { resourceUri: 'github:pr:org/repo#91' },
          { resourceUri: 'github:pr-review-thread:org/repo#91/rt_501' },
        ],
      });
    });

    it('auto-registers the originating ticket as a correlated resource on first sight, once', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 60,
              title: 'Auto register',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
          // Deliberately offset from the tick clock above. In production the
          // work source stamps its own ingestedAt inside pollEvents(), which
          // runs *after* the tick captures tickStartedAt, so the origin upsert
          // is always LATER than the tick's `now`. Pinning both clocks to the
          // same instant hides every ordering bug this asymmetry causes.
          now: () => new Date('2026-07-05T12:00:01.000Z'),
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 60 });
      expect(projection?.correlatedResources).toEqual([
        {
          resourceUri: 'fake-ticketing:issue:atolis-hq/wake#60',
          role: 'representation',
          relation: 'primary',
          provenance: 'wake-created',
          // max(origin upsert's ingestedAt, tick's nowIso) — the origin upsert
          // (polled at 12:00:01) is later than the tick's start (12:00:00), so
          // the registration takes the upsert's timestamp and can never sort
          // before the projection it folds into.
          registeredAt: '2026-07-05T12:00:01.000Z',
        },
      ]);

      const registrationEvents = (await store.listEventEnvelopes()).filter(
        (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
      );
      expect(registrationEvents).toHaveLength(1);

      // A second tick over the same, already-registered ticket must not
      // append a duplicate registration.
      await tickRunner.runTick();
      const registrationEventsAfterSecondTick = (await store.listEventEnvelopes()).filter(
        (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
      );
      expect(registrationEventsAfterSecondTick).toHaveLength(1);
    });

    it('does not re-claim a deliberately retracted origin resource on a later tick', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      const resourceIndex = createFakeResourceIndex();

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 61,
              title: 'Retract then re-tick',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
          // Offset from the tick clock — see the auto-registration test above.
          now: () => new Date('2026-07-05T12:00:01.000Z'),
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      // First tick mints the work item, which registers the origin ticket.
      await tickRunner.runTick();
      const registeredBefore = (await store.listEventEnvelopes()).filter(
        (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
      );
      expect(registeredBefore).toHaveLength(1);

      const workItemKey =
        (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 61 }))?.workItemKey ??
        '';

      // The operator (or a later `wake correlate` command) deliberately
      // retracts the only correlated resource, leaving correlatedResources[]
      // legitimately empty — this must be durable, not just a transient state
      // that the next tick silently reverses.
      const projectionUpdater = createProjectionUpdater({ stateStore: store, resourceIndex });
      const retraction = createEventEnvelope({
        eventId: 'wake-61-origin-retracted',
        workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: 'wake.correlation.retracted',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 61 },
        occurredAt: '2026-07-05T12:05:00.000Z',
        ingestedAt: '2026-07-05T12:05:00.000Z',
        trigger: 'context-only',
        payload: { resourceUri: 'fake-ticketing:issue:atolis-hq/wake#61' },
      });
      await store.appendEventEnvelope(retraction);
      await projectionUpdater.rebuildFromEvents([retraction]);

      const afterRetraction = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 61,
      });
      expect(afterRetraction?.correlatedResources).toEqual([]);

      // A later tick must not silently re-claim the retracted uri for this work
      // item. There is no longer a back-fill pass that could: minting *is*
      // registration, and this work item is never minted again. The re-polled
      // upsert resolves by its already-persisted event id, so it folds back into
      // the same work item without re-registering anything.
      await tickRunner.runTick();

      const registeredAfter = (await store.listEventEnvelopes()).filter(
        (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
      );
      expect(registeredAfter).toHaveLength(1);

      const finalProjection = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 61,
      });
      expect(finalProjection?.correlatedResources).toEqual([]);
      expect(finalProjection?.workItemKey).toBe(workItemKey);

      // And no second work item was forked for the now-unclaimed ticket.
      expect(await store.listIssueStates()).toHaveLength(1);
    });

    it('mints a work id for a ticket discovered on a clean home, emitting created then registered, and keys state/ on it', async () => {
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
              number: 200,
              title: 'Mint me',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
          // Offset from the tick clock, as production always is: the source
          // stamps ingestedAt inside pollEvents(), after the tick's own start.
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

      const projection = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 200,
      });
      expect(projection).not.toBeNull();
      const workId = projection?.workItemKey ?? '';
      expect(isWorkId(workId)).toBe(true);

      // The projection lands at state/<workId>.json — no provider, repo, or
      // issue segment anywhere in the path.
      await access(join(root, 'state', `${workId}.json`));

      // The index is what makes the *next* event resolve rather than re-mint.
      expect(await resourceIndex.resolve('fake-ticketing:issue:atolis-hq/wake#200')).toBe(workId);

      const events = await store.listEventEnvelopes();
      const mintEventTypes = events
        .filter(
          (event) =>
            event.workItemKey === workId &&
            (event.sourceEventType === WORK_ITEM_CREATED_EVENT ||
              event.sourceEventType === CORRELATION_REGISTERED_EVENT),
        )
        .map((event) => event.sourceEventType);
      expect(mintEventTypes).toEqual([WORK_ITEM_CREATED_EVENT, CORRELATION_REGISTERED_EVENT]);

      expect(projection?.correlatedResources).toEqual([
        {
          resourceUri: 'fake-ticketing:issue:atolis-hq/wake#200',
          role: 'representation',
          relation: 'primary',
          provenance: 'wake-created',
          registeredAt: '2026-07-05T12:00:01.000Z',
        },
      ]);
    });

    it('resolves a second event on the same ticket through the index to the same work id and mints nothing', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createResourceIndex({ paths: store.paths });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      // The second tick's ticket carries a comment, so the second poll emits a
      // genuinely *new* event id for the same ticket. That is what forces the
      // resolver down the index path — re-polling the identical event id would
      // instead take the already-persisted shortcut and prove nothing about
      // resolution.
      const tickets = [
        {
          repo: 'atolis-hq/wake',
          number: 201,
          title: 'Mint once',
          body: 'Body',
          labels: ['wake:queue'],
          comments: [] as Array<{ id: string; body: string; author: { login: string } }>,
        },
      ];

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        resourceIndex,
        workSource: createFakeTicketingSystem({
          tickets,
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
      const firstWorkId = (
        await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 201 })
      )?.workItemKey;
      expect(isWorkId(firstWorkId ?? '')).toBe(true);

      tickets[0]!.comments.push({ id: 'c-201', body: 'A new comment', author: { login: 'alice' } });
      await tickRunner.runTick();

      const projections = await store.listIssueStates();
      expect(projections).toHaveLength(1);
      expect(projections[0]?.workItemKey).toBe(firstWorkId);

      const events = await store.listEventEnvelopes();
      const commentEvent = events.find(
        (event) => event.sourceEventType === 'fake.issue.comment.created',
      );
      expect(commentEvent?.workItemKey).toBe(firstWorkId);

      expect(
        events.filter((event) => event.sourceEventType === WORK_ITEM_CREATED_EVENT),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT),
      ).toHaveLength(1);
    });

    it('mints two different work ids for two different tickets', async () => {
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
              number: 202,
              title: 'First',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
            {
              repo: 'atolis-hq/wake',
              number: 203,
              title: 'Second',
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

      const first = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 202,
      });
      const second = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 203,
      });

      expect(isWorkId(first?.workItemKey ?? '')).toBe(true);
      expect(isWorkId(second?.workItemKey ?? '')).toBe(true);
      expect(first?.workItemKey).not.toBe(second?.workItemKey);
    });

    it('re-registers the origin resource when an earlier mint was interrupted before it landed, so a later event does not fork a duplicate', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createFakeResourceIndex();
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const tickets = [
        {
          repo: 'atolis-hq/wake',
          number: 301,
          title: 'Interrupted mint',
          body: 'Body',
          labels: ['wake:queue'],
          comments: [] as Array<{ id: string; body: string; author: { login: string } }>,
        },
      ];

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        resourceIndex,
        workSource: createFakeTicketingSystem({
          tickets,
          now: () => new Date('2026-07-05T12:00:01.000Z'),
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      // First tick mints the work item and registers its origin ticket.
      await tickRunner.runTick();
      const workItemKey =
        (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 301 }))?.workItemKey ??
        '';
      expect(isWorkId(workItemKey)).toBe(true);
      const uri = 'fake-ticketing:issue:atolis-hq/wake#301';
      expect(await resourceIndex.resolve(uri)).toBe(workItemKey);

      // Simulate a crash that landed between appending the origin ticket's source
      // event and folding its origin correlation: the source event stays durable
      // (so the resolver's persisted shortcut fires and it is never re-minted),
      // but the index entry and the origin-correlation event never made it.
      await resourceIndex.retract(uri);
      await rm(join(root, 'events-by-id', `${workItemKey}-origin-correlation.json`), {
        force: true,
      });
      await rm(join(root, 'events-by-id', `${workItemKey}-created.json`), { force: true });

      // A later poll re-emits the same upsert (heal path) and a brand-new comment
      // on the same ticket. Without healing, the comment would miss the index and
      // fork a second work item.
      tickets[0]!.comments.push({ id: 'c-301', body: 'ping', author: { login: 'alice' } });
      await tickRunner.runTick();

      expect(await resourceIndex.resolve(uri)).toBe(workItemKey);
      expect(await store.listIssueStates()).toHaveLength(1);
      const commentEvent = (await store.listEventEnvelopes()).find(
        (event) => event.sourceEventType === 'fake.issue.comment.created',
      );
      expect(commentEvent?.workItemKey).toBe(workItemKey);
    });

    it('does not re-claim a deliberately retracted origin resource via the heal path', async () => {
      // Sibling of the retraction test above, guarding the heal specifically: a
      // retracted resource resolves to undefined but keeps its origin-correlation
      // event, so the heal must leave it alone rather than re-register it.
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createFakeResourceIndex();
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
              number: 302,
              title: 'Retracted then re-polled',
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
      const uri = 'fake-ticketing:issue:atolis-hq/wake#302';
      // Retract only the index entry, leaving the origin-correlation event on
      // record — the durable signature of an intentional retraction, not a crash.
      await resourceIndex.retract(uri);

      await tickRunner.runTick();

      // The heal must NOT fire: the resource stays unclaimed.
      expect(await resourceIndex.resolve(uri)).toBeUndefined();
      expect(await store.listIssueStates()).toHaveLength(1);
    });

    it('does not re-append an already-persisted inbound event on a later tick', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createResourceIndex({ paths: store.paths });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const appendedIds: string[] = [];
      const countingStore = {
        ...store,
        async appendEventEnvelope(event: Parameters<typeof store.appendEventEnvelope>[0]) {
          appendedIds.push(event.eventId);
          return store.appendEventEnvelope(event);
        },
      };

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: countingStore,
        resourceIndex,
        workSource: createFakeTicketingSystem({
          tickets: [
            {
              repo: 'atolis-hq/wake',
              number: 210,
              title: 'Once',
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
      await tickRunner.runTick();

      // The upsert is durable after tick 1; tick 2 re-polls the identical event
      // id and must resolve it straight from disk without a second append.
      const upsertId = 'fake-issue-atolis-hq/wake-210';
      expect(appendedIds.filter((id) => id === upsertId)).toHaveLength(1);
    });

    it('keys the pending-marking runId on the work id, not the bare ticket number', async () => {
      const store = createStateStore({ wakeRoot: root });
      const pendingRunIds: string[] = [];

      for (const issueNumber of [41, 42]) {
        await store.writeIssueState({
          schemaVersion: 1,
          workItemKey: workId(issueNumber),
          issue: {
            repo: 'atolis-hq/wake',
            number: issueNumber,
            title: `Approval ${issueNumber}`,
            body: 'Body',
            labels: ['wake:queue', 'wake:status.awaiting-approval', 'wake:stage.implement'],
            assignees: [],
            isPullRequest: false,
            state: 'open',
            url: `https://example.test/issues/${issueNumber}`,
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
          comments: [],
          wake: {
            stage: 'implement',
            stageHistory: [],
            recentEventIds: [],
            syncedAt: '2026-07-05T12:00:00.000Z',
            expectedEcho: { commentIds: [], labels: [] },
          },
          context: {
            lastRunSentinel: 'AWAITING_APPROVAL',
            pendingApprovalAction: 'implement',
          },
          correlatedResources: [],
        });
      }

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [41, 42].map((issueNumber) => ({
              schemaVersion: 1 as const,
              eventId: `evt-comment-${issueNumber}`,
              streamScope: 'work-item' as const,
              direction: 'inbound' as const,
              sourceSystem: 'github',
              sourceEventType: 'ticket.comment.created',
              sourceRefs: {
                repo: 'atolis-hq/wake',
                issueNumber,
                commentId: `c-${issueNumber}`,
                resourceUri: githubIssueUri(issueNumber),
              },
              occurredAt: '2026-07-05T12:09:00.000Z',
              ingestedAt: '2026-07-05T12:09:00.000Z',
              trigger: 'context-only' as const,
              payload: {
                comment: {
                  id: `c-${issueNumber}`,
                  body: issueNumber === 41 ? '/approved' : '/changes Please adjust this.',
                  author: { login: 'owner' },
                  createdAt: '2026-07-05T12:09:00.000Z',
                  updatedAt: '2026-07-05T12:09:00.000Z',
                },
              },
            }));
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            if (
              input.event.sourceEventType === 'wake.labels.requested' &&
              input.event.payload.statusLabel === 'wake:status.pending'
            ) {
              pendingRunIds.push(String(input.event.sourceRefs.runId));
            }
            return [];
          },
        },
        runner: {
          async run() {
            return { result: 'Revised.\nDONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: await seededResourceIndex([41, 42]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      expect(pendingRunIds.length).toBeGreaterThanOrEqual(1);
      for (const runId of pendingRunIds) {
        expect(runId.startsWith('pending-work-')).toBe(true);
      }
      // The seeded work id appears; the bare "pending-41-"/"pending-42-" shape never does.
      expect(pendingRunIds.some((id) => id.includes(workId(41)) || id.includes(workId(42)))).toBe(
        true,
      );
      expect(pendingRunIds.every((id) => !/^pending-4[12]-/.test(id))).toBe(true);
    });

    it('fails loudly rather than minting when a polled event carries no sourceRefs.resourceUri', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);

      // Deliberately ad-hoc rather than one of the fakes: both fakes stamp a
      // resourceUri by construction, so no fake can produce this shape. An
      // unkeyed event without a resourceUri is a programming error in the
      // adapter — the resolver has nothing to resolve and must never guess an
      // identity, because a guess forks a duplicate work item silently.
      const brokenWorkSource = {
        async pollEvents() {
          return [
            {
              schemaVersion: 1 as const,
              eventId: 'broken-1',
              streamScope: 'global-intake' as const,
              direction: 'inbound' as const,
              sourceSystem: 'broken-source',
              sourceEventType: 'ticket.upsert',
              sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 204 },
              occurredAt: '2026-07-05T12:00:01.000Z',
              ingestedAt: '2026-07-05T12:00:01.000Z',
              trigger: 'immediate' as const,
              payload: {},
            },
          ];
        },
      };

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        resourceIndex: createFakeResourceIndex(),
        workSource: brokenWorkSource,
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await expect(tickRunner.runTick()).rejects.toThrow(/resourceUri/);

      const events = await store.listEventEnvelopes();
      expect(events.filter((event) => event.sourceEventType === WORK_ITEM_CREATED_EVENT)).toEqual(
        [],
      );
    });
  });
});
