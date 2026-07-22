import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeArtifactVerifier } from '../../src/adapters/fake/fake-artifact-verifier.js';
import { createFakeGitHubPullRequestActivitySource } from '../../src/adapters/fake/fake-github-pull-request-activity-source.js';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createOutboundSinkRouter, createWorkSourceFanIn } from '../../src/core/sink-router.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import type { EventEnvelope, IssueStateRecord } from '../../src/domain/types.js';
import { createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';
import {
  findByIssueRef,
  githubIssueUri,
  ticketUpsertWorkSource,
  workId,
} from './support/tick-runner-fixtures.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  describe('artifact reporting', () => {
    it('registers a verified PR artifact reported by the agent', async () => {
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(41),
        issue: {
          repo: 'atolis-hq/wake',
          number: 41,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/41',
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
        correlatedResources: [],
      });

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      const artifactVerifier = createFakeArtifactVerifier({
        verifies: [
          { url: 'https://example.test/org/repo/pull/91', resourceUri: 'github:pr:org/repo#91' },
        ],
      });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: [
                'Opened the PR.',
                '',
                '```wake-artifacts',
                '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/org/repo/pull/91" }] }',
                '```',
                '',
                '```wake-result',
                '{ "status": "AWAITING_APPROVAL" }',
                '```',
                'AWAITING_APPROVAL',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'fake-session-1',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier,
      });

      await tickRunner.runTick();

      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 41 });
      expect(projection?.correlatedResources).toContainEqual(
        expect.objectContaining({
          resourceUri: 'github:pr:org/repo#91',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        }),
      );
    });

    it('does not register an artifact that fails verification', async () => {
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(42),
        issue: {
          repo: 'atolis-hq/wake',
          number: 42,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/42',
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
        correlatedResources: [],
      });

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      // verifies: [] — verify() always returns null, exercising the failed-
      // verification path.
      const artifactVerifier = createFakeArtifactVerifier({ verifies: [] });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: [
                'Opened the PR.',
                '',
                '```wake-artifacts',
                '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/org/repo/pull/91" }] }',
                '```',
                '',
                '```wake-result',
                '{ "status": "AWAITING_APPROVAL" }',
                '```',
                'AWAITING_APPROVAL',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'fake-session-1',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier,
      });

      await tickRunner.runTick();

      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 42 });
      expect(
        projection?.correlatedResources.some((r) => r.resourceUri === 'github:pr:org/repo#91'),
      ).toBe(false);
    });

    it("threads the work item's own repo into the artifact verifier context", async () => {
      // Fix 3 regression: the artifact verifier must be able to confirm a
      // reported PR's repo matches the work item's own repo, not just its
      // branch — a low-entropy branch name like wake/issue-<n> could
      // otherwise match a PR in an unrelated repo. This proves tick-runner
      // actually threads the work item's repo (candidate.issue.repo) through
      // to the verifier's context, using a verifier that records what it was
      // called with rather than the shared fake (which ignores context).
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(43),
        issue: {
          repo: 'atolis-hq/wake',
          number: 43,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/43',
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
        correlatedResources: [],
      });

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      const capturedContexts: Array<{ branch: string; repo: string }> = [];
      const artifactVerifier = {
        async verify(_artifact: unknown, context: { branch: string; repo: string }) {
          capturedContexts.push(context);
          return null;
        },
      };

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: [
                'Opened the PR.',
                '',
                '```wake-artifacts',
                '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/org/repo/pull/91" }] }',
                '```',
                '',
                '```wake-result',
                '{ "status": "AWAITING_APPROVAL" }',
                '```',
                'AWAITING_APPROVAL',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'fake-session-1',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier,
      });

      await tickRunner.runTick();

      expect(capturedContexts).toHaveLength(1);
      expect(capturedContexts[0]?.repo).toBe('atolis-hq/wake');
    });
  });

  describe('mint qualification gate', () => {
    it('parks an unqualified unresolved event in global-intake instead of minting', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:assign'];

      const now = new Date('2026-07-05T12:00:00.000Z');

      const tickRunner = createTickRunner({
        clock: { now: () => now },
        config,
        stateStore: store,
        workSource: ticketUpsertWorkSource({
          repo: 'atolis-hq/wake',
          issueNumber: 501,
          labels: [],
          now,
        }),
        runner: {
          async run() {
            throw new Error('runner must not be invoked for an unqualified event');
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const outcome = await tickRunner.runTick();
      expect(outcome.status).toBe('idle');

      const projections = await store.listIssueStates();
      expect(projections).toHaveLength(0);

      // listEventEnvelopesForWorkItem reads recentEventIds off a projection,
      // which the 'unresolved' sentinel key never has — read the raw JSONL
      // event log directly instead, the same pattern used elsewhere in this
      // file (e.g. "creates event audit records for sync and completion").
      const lines = (await readFile(store.paths.eventFile('2026-07-05'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              workItemKey: string;
              sourceRefs: { resourceUri?: string };
            },
        );
      const unresolvedEvents = lines.filter((event) => event.workItemKey === 'unresolved');

      expect(unresolvedEvents).toHaveLength(1);
      expect(unresolvedEvents[0]?.sourceRefs.resourceUri).toBe(githubIssueUri(501));
    });

    it('still mints a work item for a qualifying unresolved event', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const now = new Date('2026-07-05T12:00:00.000Z');

      const tickRunner = createTickRunner({
        clock: { now: () => now },
        config,
        stateStore: store,
        workSource: ticketUpsertWorkSource({
          repo: 'atolis-hq/wake',
          issueNumber: 502,
          labels: ['wake:queue'],
          now,
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const outcome = await tickRunner.runTick();
      expect(outcome.status).not.toBe('idle');

      const projections = await store.listIssueStates();
      expect(projections).toHaveLength(1);
    });

    it('resolves a first-sighting PR review-thread comment to the owning PR work item via sourceRefs.parentResourceUri, rather than quarantining it as unresolved', async () => {
      // A review-thread comment's resourceUri is unique per thread and is
      // never registered in the index on its own — only the owning PR's
      // resourceUri is. Without the parentResourceUri fallback, resolving
      // straight off the thread's resourceUri always misses the index and
      // (since qualifiesForMint has no 'pr-review-thread' case) permanently
      // quarantines the event under UNRESOLVED_WORK_ITEM_KEY.
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      const prResourceUri = 'github:pr:org/repo#91';
      const threadResourceUri = 'github:pr-review-thread:org/repo#91/rt_501';
      const key = workId(91);

      const resourceIndex = createFakeResourceIndex();
      await resourceIndex.register(prResourceUri, key);

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: key,
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
            resourceUri: prResourceUri,
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: '2026-07-05T12:00:00.000Z',
          },
        ],
      });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [
              createUnkeyedEventEnvelope({
                eventId: 'pr-review-comment-org-repo-91-601-2026-07-05T12:00:00.000Z',
                streamScope: 'work-item',
                direction: 'inbound',
                sourceSystem: 'github-pr',
                sourceEventType: 'pr.review-comment.created',
                sourceRefs: {
                  resourceUri: threadResourceUri,
                  parentResourceUri: prResourceUri,
                  commentId: '601',
                },
                occurredAt: '2026-07-05T12:00:00.000Z',
                ingestedAt: '2026-07-05T12:00:00.000Z',
                trigger: 'context-only',
                payload: {
                  comment: {
                    id: 'pr-review-comment-601',
                    body: 'Nit: rename this variable.',
                    author: { login: 'reviewer' },
                    createdAt: '2026-07-05T12:00:00.000Z',
                    updatedAt: '2026-07-05T12:00:00.000Z',
                    resourceUri: threadResourceUri,
                  },
                },
              }),
            ];
          },
        },
        runner: {
          async run() {
            throw new Error('should not run');
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const projections = await store.listIssueStates();
      expect(projections).toHaveLength(1);
      expect(projections[0]?.workItemKey).toBe(key);
      expect(projections[0]?.latestComment?.id).toBe('pr-review-comment-601');
      expect(projections[0]?.correlatedResources.map((r) => r.resourceUri)).toContain(
        threadResourceUri,
      );
      expect(
        projections[0]?.correlatedResources.find((r) => r.resourceUri === threadResourceUri)
          ?.relation,
      ).toBe('secondary');
    });
  });

  describe('end-to-end: issue -> implement -> PR review comment -> resume -> reply on the thread', () => {
    it('resumes the issue work item from a PR review comment and replies on the PR sink, not the issue sink', async () => {
      // Adaptation 1 (brief step 6/7 named a review-thread comment routed to
      // `github:pr-review-thread:...`): the fake PR activity source (Task
      // 10, fake-github-pull-request-activity-source.ts) only emits plain
      // `pr.comment.created` conversation events, never
      // `pr.review-comment.created` review-thread events. Per this task's
      // brief guidance (option a), this scenario uses a plain PR
      // conversation comment (`github:pr:org/repo#91`) instead. It still
      // proves every load-bearing claim: an agent-reported PR is verified
      // and registered (step 3), a human reply resumes the SAME session
      // (steps 1-4), and a later comment on the PR surface resumes that
      // same session again and gets its reply routed to the PR sink instead
      // of the issue sink (steps 5-7) — extending a review thread instead of
      // the top-level conversation would exercise the same routing code
      // path (sinkNameForResourceUri treats 'pr' and 'pr-review-thread'
      // identically), so nothing about the routing claim is weakened.
      //
      // Adaptation 2 (brief step 4 imagines a literal '/approved' comment
      // leaving the item "in 'implement' with a live session"): tracing the
      // real approval path shows this can't hold. Approving an
      // implement-stage AWAITING_APPROVAL always resolves via
      // lifecycle-service's `nextStageFromSentinel('implement', 'DONE')`,
      // which unconditionally returns 'done' — see the existing test
      // "transitions an awaiting-approval status to done when /approved
      // comment is present" above. Moving stage forward always clears
      // `wake.sessionId` (projection-updater.ts's `shouldClearSession`), so
      // a full approval leaves nothing for a later PR comment to resume.
      // This scenario instead uses the BLOCKED / human-reply resume cycle
      // this file already exercises elsewhere (e.g. "runs once when a new
      // human comment arrives on an eligible issue"), which is
      // session-preserving by design — while still posting a comment
      // literally worded '/approved' so the human step stays recognisable.
      //
      // PRODUCTION FIX NOTE: writing this scenario surfaced a real gap —
      // src/core/tick-runner.ts's createPublishIntentEvent never carried a
      // `resourceUri` on the outbound wake.publish.intent.requested event,
      // so createOutboundSinkRouter's PR-vs-issue routing (Task 11,
      // sink-router.ts, commit 7512226) had no signal to route on and every
      // reply landed on the issue sink regardless of which surface
      // triggered the run. Fixed narrowly by threading
      // `projection.latestComment?.resourceUri` (already populated by the
      // ad1cf45 comment fold when the triggering comment came from a
      // correlated PR/review surface) into that event's sourceRefs. See the
      // task report for detail.
      const repo = 'atolis-hq/wake';
      const issueNumber = 91;
      const workKey = workId(issueNumber);
      const prUrl = 'https://example.test/org/repo/pull/91';
      const prResourceUri = 'github:pr:org/repo#91';

      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createFakeResourceIndex();
      await resourceIndex.register(githubIssueUri(issueNumber), workKey);
      const workspaceManager = createFakeWorkspaceManager(join(root, 'workspaces'));

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      const artifactVerifier = createFakeArtifactVerifier({
        verifies: [{ url: prUrl, resourceUri: prResourceUri }],
      });

      // One shared issue-thread sink across all three ticks — every tick
      // must confirm its own outbound intents (deliverOutboundEvent ->
      // attemptDelivery) as it goes, or a later tick's
      // retryUnconfirmedDeliveries replays them in a batch instead. This
      // mirrors the no-op-reply outboundSink shape used throughout this
      // file (e.g. "publishes working then completed status labels...")
      // rather than createFakeTicketingSystem's full echo, which replaces
      // issue.labels with exactly `[statusLabel, stageLabel]` on delivery —
      // that would wipe this fixture's 'wake:implement' qualifying label,
      // which isn't one of Wake's own status/stage labels.
      const githubIssueSink = {
        async deliverIntent(_input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
          return [];
        },
      };

      let runnerCallCount = 0;
      const capturedSessionIds: Array<string | undefined> = [];

      // Step 1: seed a ticket already in 'implement' with no prior run,
      // mirroring this file's implement-stage fixtures (e.g. "artifact
      // reporting" above).
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workKey,
        issue: {
          repo,
          number: issueNumber,
          title: 'Implement PR review flow',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: `https://example.test/${repo}/issues/${issueNumber}`,
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
        correlatedResources: [],
      });

      // Step 2: first tick — the agent opens a PR (reported via the
      // wake-artifacts fence, Task 4's pattern) but comes back BLOCKED with
      // a clarifying question rather than AWAITING_APPROVAL/DONE, so the
      // session survives to be resumed later (see adaptation 2 above).
      const tickRunner1 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: githubIssueSink,
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Opened the PR. Quick question before I finish up: should the retry cap be configurable?',
                '',
                '```wake-artifacts',
                `{ "artifacts": [{ "kind": "pr", "url": "${prUrl}" }] }`,
                '```',
                '',
                '```wake-result',
                '{ "status": "BLOCKED" }',
                '```',
                'BLOCKED',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      const tick1Result = await tickRunner1.runTick();
      expect(tick1Result.status).toBe('processed');
      expect((tick1Result as { sentinel?: string }).sentinel).toBe('BLOCKED');
      expect(runnerCallCount).toBe(1);

      // Step 3: correlatedResources holds the verified, agent-reported PR.
      let projection = await findByIssueRef(store, { repo, issueNumber });
      expect(projection?.correlatedResources).toContainEqual(
        expect.objectContaining({
          resourceUri: prResourceUri,
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        }),
      );
      expect(projection?.wake.stage).toBe('implement');
      expect(projection?.wake.sessionId).toBe('session-91');
      expect(projection?.context.lastRunSentinel).toBe('BLOCKED');

      // Step 4: a human replies with a plain ticket comment (the same
      // inbound shape the fake ticketing system's comment-seed path
      // produces) — this resumes the SAME session rather than a fresh one.
      const tickRunner2 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:05:00.000Z') },
        config,
        stateStore: store,
        outboundSink: githubIssueSink,
        workSource: {
          async pollEvents() {
            return [
              {
                schemaVersion: 1,
                eventId: 'evt-comment-91-approved',
                streamScope: 'work-item',
                direction: 'inbound',
                sourceSystem: 'github',
                sourceEventType: 'ticket.comment.created',
                sourceRefs: {
                  repo,
                  issueNumber,
                  commentId: 'c-91-approved',
                  resourceUri: githubIssueUri(issueNumber),
                },
                occurredAt: '2026-07-05T12:05:00.000Z',
                ingestedAt: '2026-07-05T12:05:00.000Z',
                trigger: 'context-only',
                payload: {
                  comment: {
                    id: 'c-91-approved',
                    body: '/approved',
                    author: { login: 'owner' },
                    createdAt: '2026-07-05T12:05:00.000Z',
                    updatedAt: '2026-07-05T12:05:00.000Z',
                  },
                },
              },
            ];
          },
        },
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Thanks — keeping the retry cap fixed for now. One more thing to confirm before this is fully done.',
                '',
                '```wake-result',
                '{ "status": "BLOCKED" }',
                '```',
                'BLOCKED',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      const tick2Result = await tickRunner2.runTick();
      expect(tick2Result.status).toBe('processed');
      expect(runnerCallCount).toBe(2);
      // Same session resumed, not a fresh one.
      expect(capturedSessionIds[1]).toBe('session-91');

      projection = await findByIssueRef(store, { repo, issueNumber });
      expect(projection?.wake.stage).toBe('implement');
      expect(projection?.wake.sessionId).toBe('session-91');

      // Step 5: a fake PR activity source (Task 10) seeded with one PR
      // conversation comment on the now-correlated PR, fanned in alongside
      // the issue source, with an outbound sink router registering the
      // issue sink under 'github' (the projection's origin fallback) and
      // the PR sink under 'github-pr' (the name sinkNameForResourceUri
      // derives from a `github:pr:...`/`github:pr-review-thread:...`
      // resourceUri, per Task 11).
      const prActivitySource = createFakeGitHubPullRequestActivitySource({
        prs: [
          {
            repo: 'org/repo',
            number: 91,
            author: 'contributor',
            headRef: 'wake/91',
            comments: [
              {
                id: 'prc-1',
                body: 'Please also handle the null case on line 42.',
                author: 'reviewer',
              },
            ],
          },
        ],
        now: () => new Date('2026-07-05T12:10:00.000Z'),
      });

      const githubSinkReceived: EventEnvelope[] = [];
      const prSinkReceived: EventEnvelope[] = [];
      const prSinkPublished: EventEnvelope[] = [];

      const outboundSink = createOutboundSinkRouter({
        config,
        sinks: [
          {
            sink: 'github',
            async deliverIntent(input) {
              githubSinkReceived.push(input.event);
              return githubIssueSink.deliverIntent(input);
            },
          },
          {
            sink: 'github-pr',
            async deliverIntent(input) {
              prSinkReceived.push(input.event);
              const delivered = await prActivitySource.deliverIntent(input);
              prSinkPublished.push(...delivered);
              return delivered;
            },
          },
        ],
      });

      const workSource = createWorkSourceFanIn([
        {
          source: 'fake-ticketing',
          async pollEvents() {
            return [];
          },
        },
        { source: 'fake-github-pr', pollEvents: prActivitySource.pollEvents },
      ]);

      const tickRunner3 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource,
        outboundSink,
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Handled the null check on line 42, thanks for the catch.',
                '',
                '```wake-result',
                '{ "status": "BLOCKED" }',
                '```',
                'BLOCKED',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      // Step 6: second tick against the PR-aware runtime. The watchlist
      // (derived from correlatedResources registered in step 3) now
      // includes github:pr:org/repo#91, so the fake PR source emits the
      // conversation comment instead of a bare pr.seen event, and the work
      // item resumes with the SAME session rather than minting a new run.
      const tick3Result = await tickRunner3.runTick();
      expect(tick3Result.status).toBe('processed');
      expect(runnerCallCount).toBe(3);
      expect(capturedSessionIds[2]).toBe('session-91');

      projection = await findByIssueRef(store, { repo, issueNumber });
      expect(projection?.comments.some((c) => c.id === 'prc-1')).toBe(true);
      // The triggering comment is tagged with the PR surface it came from
      // (ad1cf45's comment fold) — this is exactly the signal the
      // production fix above threads onto the reply's publish intent.
      expect(projection?.latestComment?.resourceUri).toBe(prResourceUri);

      // Step 7: the reply was routed to the PR sink, not the issue sink —
      // the resourceUri on the triggering run's publish intent carries the
      // PR surface, and only the 'github-pr' sink received it.
      expect(
        githubSinkReceived.some(
          (event) => event.sourceEventType === 'wake.publish.intent.requested',
        ),
      ).toBe(false);
      expect(prSinkReceived).toHaveLength(1);
      expect(prSinkReceived[0]?.sourceEventType).toBe('wake.publish.intent.requested');
      expect(prSinkReceived[0]?.sourceRefs.resourceUri).toBe(prResourceUri);

      expect(prSinkPublished).toHaveLength(1);
      expect(prSinkPublished[0]?.sourceEventType).toBe('pr.comment.reply.published');

      // Step 8 (review fix regression): `latestComment` is a sticky,
      // per-work-item field (projection-updater.ts's comment fold overwrites
      // it unconditionally and nothing ever resets it) — it still points at
      // prc-1/prResourceUri here even though tick 3 already handled that
      // comment (context.lastHandledCommentId === 'prc-1'). Simulate a run
      // that completes for a reason OTHER than a fresh comment — an
      // automatic quota-failure retry, one of needsWakeAction's non-comment
      // trigger paths — and confirm the reply does NOT get misrouted to the
      // PR sink just because the projection's stale latestComment still
      // carries a PR resourceUri from a comment that was already replied to.
      const preTick4Projection = await findByIssueRef(store, { repo, issueNumber });
      expect(preTick4Projection).not.toBeNull();
      await store.writeIssueState({
        ...(preTick4Projection as IssueStateRecord),
        context: {
          ...(preTick4Projection as IssueStateRecord).context,
          lastRunSentinel: 'FAILED',
          lastFailureClass: 'quota',
          lastRunAction: 'implement',
        },
      });

      const tickRunner4 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:15:00.000Z') },
        config,
        stateStore: store,
        workSource: createWorkSourceFanIn([
          {
            source: 'fake-ticketing',
            async pollEvents() {
              return [];
            },
          },
          {
            source: 'fake-github-pr',
            async pollEvents() {
              return [];
            },
          },
        ]),
        outboundSink,
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Retried after the quota backoff cleared; nothing new to report.',
                '',
                '```wake-result',
                '{ "status": "DONE" }',
                '```',
                'DONE',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      const tick4Result = await tickRunner4.runTick();
      expect(tick4Result.status).toBe('processed');
      expect(runnerCallCount).toBe(4);
      const tick4RunId = (tick4Result as { runId?: string }).runId;
      expect(tick4RunId).toBeDefined();

      // The quota-retry run wasn't triggered by a fresh comment, so its own
      // reply must go to the issue sink, not the PR sink — even though the
      // projection's sticky latestComment.resourceUri still names the PR.
      // (retryUnconfirmedDeliveries may also re-attempt tick 3's still-
      // unconfirmed PR delivery during this tick; identify tick 4's own
      // intent by runId to avoid conflating the two.)
      expect(
        prSinkReceived.some(
          (event) =>
            event.sourceEventType === 'wake.publish.intent.requested' &&
            event.sourceRefs.runId === tick4RunId,
        ),
      ).toBe(false);
      const tick4GithubIntent = githubSinkReceived.find(
        (event) =>
          event.sourceEventType === 'wake.publish.intent.requested' &&
          event.sourceRefs.runId === tick4RunId,
      );
      expect(tick4GithubIntent).toBeDefined();
      expect(tick4GithubIntent?.sourceRefs.resourceUri).toBeUndefined();

      // Fix 1 regression: 'pr.comment.reply.published' (the confirmation
      // event the PR sink's deliverIntent returns on success, asserted at
      // line ~4366) must be recognized by
      // outboundConfirmationEventTypes — otherwise retryUnconfirmedDeliveries
      // never sees tick 3's PR reply as confirmed and re-delivers it on every
      // subsequent tick, forever, reposting the same comment to the real PR
      // thread with no bound. tick 4 above already re-triggered
      // retryUnconfirmedDeliveries once; a fixed implementation must not have
      // redelivered tick 3's reply during that pass.
      expect(prSinkPublished).toHaveLength(1);

      // Step 9: one more tick with no new triggering activity at all (no
      // fresh comment, no failed run to retry) — the strongest form of the
      // regression check. If the fix is missing, retryUnconfirmedDeliveries
      // finds tick 3's PR reply intent still unconfirmed and redelivers it
      // yet again here.
      const tickRunner5 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:20:00.000Z') },
        config,
        stateStore: store,
        workSource: createWorkSourceFanIn([
          {
            source: 'fake-ticketing',
            async pollEvents() {
              return [];
            },
          },
          {
            source: 'fake-github-pr',
            async pollEvents() {
              return [];
            },
          },
        ]),
        outboundSink,
        runner: {
          async run() {
            throw new Error('no eligible work item should trigger a run on tick 5');
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      await tickRunner5.runTick();

      // Still exactly one PR-sink delivery across all five ticks: tick 3's
      // reply was never redelivered by any later tick's outbox retry.
      expect(prSinkPublished).toHaveLength(1);
    });
  });
});
