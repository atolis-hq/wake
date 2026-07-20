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

  describe('stale-run reconciliation', () => {
    it('marks stale running run records failed during a later tick', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake'];
      const claudeHaikuEntry = config.runners['claude-haiku'];
      if (claudeHaikuEntry?.kind === 'claude') {
        claudeHaikuEntry.timeoutMs = 60_000;
      }
      config.tiers.light = ['claude-haiku'];
      config.tiers.standard = ['claude-haiku'];
      let runnerCallCount = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(123),
        issue: {
          repo: 'atolis-hq/wake',
          number: 123,
          title: 'Stale run',
          body: 'Body',
          labels: ['wake'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/123',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'implement',
          lastRunId: 'run-123-stale',
          syncedAt: '2026-07-05T12:00:00.000Z',
          stageHistory: [],
          recentEventIds: [],
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
        correlatedResources: [],
      });
      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-123-stale',
        workItemKey: workId(123),
        repo: 'atolis-hq/wake',
        issueNumber: 123,
        action: 'implement',
        status: 'running',
        startedAt: '2026-07-05T12:00:00.000Z',
      });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:02:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            runnerCallCount += 1;
            return { result: 'Should not run\nDONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const runRecord = await store.readRunRecord('run-123-stale');
      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 123 });
      const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');

      expect(result.status).toBe('idle');
      expect(runnerCallCount).toBe(0);
      expect(runRecord?.status).toBe('failed');
      expect(runRecord?.sentinel).toBe('FAILED');
      expect(projection?.wake.stage).toBe('implement');
      expect(events).toContain('"eventId":"run-123-stale-stale-reconciled"');
      expect(events).toContain('"sourceEventType":"wake.labels.requested"');
      expect(events).toContain('"stageLabel":"wake:stage.implement"');
    });

    // Identity proof, not a perf proof: the run record's repo/issueNumber are a
    // human-readable snapshot, never the way its work item is found. Here the
    // ticket has since moved repo (spec D3's motivating case — a GitHub transfer
    // assigns a new number in the target repo), so the projection is reachable
    // ONLY by the work id the record carries. Under a scan of `issue` snapshots
    // this run orphans and is wrongly superseded instead of reconciled.
    it('reconciles a stale run record through its workItemKey after the ticket moved repo', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake'];
      const claudeHaikuEntry = config.runners['claude-haiku'];
      if (claudeHaikuEntry?.kind === 'claude') {
        claudeHaikuEntry.timeoutMs = 60_000;
      }
      // Staleness uses the max timeout across runners active in tiers, so the
      // tiers must be pinned to the 60s runner for the run to read as stale.
      config.tiers.light = ['claude-haiku'];
      config.tiers.standard = ['claude-haiku'];

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(300),
        issue: {
          repo: 'atolis-hq/wake-next',
          number: 900,
          title: 'Transferred',
          body: 'Body',
          labels: ['wake'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/900',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'implement',
          lastRunId: 'run-300-stale',
          syncedAt: '2026-07-05T12:00:00.000Z',
          stageHistory: [],
          recentEventIds: [],
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
        correlatedResources: [],
      });
      // The representation the run was launched against, before the transfer.
      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-300-stale',
        workItemKey: workId(300),
        repo: 'atolis-hq/wake',
        issueNumber: 123,
        action: 'implement',
        status: 'running',
        startedAt: '2026-07-05T12:00:00.000Z',
      });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:02:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            throw new Error('runner must not be invoked');
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const runRecord = await store.readRunRecord('run-300-stale');
      expect(runRecord?.status).toBe('failed');
      expect(runRecord?.sentinel).toBe('FAILED');
      expect(runRecord?.metadata?.reconciledBy).toBe('stale-running-record');

      const reconciled = await store.readEventEnvelope('run-300-stale-stale-reconciled');
      expect(reconciled?.workItemKey).toBe(workId(300));
    });

    it('supersedes a stale running record when the item has already completed a newer run', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      const claudeHaikuEntry = config.runners['claude-haiku'];
      if (claudeHaikuEntry?.kind === 'claude') {
        claudeHaikuEntry.timeoutMs = 60_000;
      }
      config.tiers.light = ['claude-haiku'];
      config.tiers.standard = ['claude-haiku'];

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(124),
        issue: {
          repo: 'atolis-hq/wake',
          number: 124,
          title: 'Recovered run',
          body: '',
          labels: ['wake'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/124',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:01:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'done',
          lastRunId: 'run-124-new',
          syncedAt: '2026-07-05T12:01:00.000Z',
          stageHistory: [],
          recentEventIds: [],
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: { lastRunAction: 'implement', lastRunSentinel: 'DONE' },
        correlatedResources: [],
      });
      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-124-stale',
        workItemKey: workId(124),
        repo: 'atolis-hq/wake',
        issueNumber: 124,
        action: 'implement',
        status: 'running',
        startedAt: '2026-07-05T12:00:00.000Z',
      });
      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-124-new',
        workItemKey: workId(124),
        repo: 'atolis-hq/wake',
        issueNumber: 124,
        action: 'implement',
        status: 'completed',
        startedAt: '2026-07-05T12:00:30.000Z',
        finishedAt: '2026-07-05T12:01:00.000Z',
        sentinel: 'DONE',
      });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:02:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
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

      const result = await tickRunner.runTick();
      const staleRecord = await store.readRunRecord('run-124-stale');
      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 124 });

      expect(result.status).toBe('idle');
      expect(staleRecord?.status).toBe('superseded');
      expect(projection?.wake.stage).toBe('done');
      expect(await store.readEventEnvelope('run-124-stale-stale-reconciled')).toBeNull();
    });
  });
});
