import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeArtifactVerifier } from '../../src/adapters/fake/fake-artifact-verifier.js';
import { labelsForWorkItem } from '../../src/domain/work-item-labels.js';
import { createFakeGitHubPullRequestActivitySource } from '../../src/adapters/fake/fake-github-pull-request-activity-source.js';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createOutboundSinkRouter, createWorkSourceFanIn } from '../../src/core/sink-router.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import { AUTONOMOUS_DECISION_AUDIT_EVENT } from '../../src/domain/schema.js';
import type { EventEnvelope, IssueStateRecord } from '../../src/domain/types.js';
import { createEventEnvelope, createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';
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

  describe('stage watchers', () => {
    const watcherNow = '2026-07-25T12:00:00.000Z';

    function configurePrReviewWatcher(
      rootPath: string,
      options: { workflowName?: string; action?: string } = {},
    ) {
      const workflowName = options.workflowName ?? 'pr-review';
      const action = options.action ?? 'pr-review';
      const config = createDefaultWakeConfig(rootPath);
      config.sources.github.policy.requiredLabels = ['wake:implement'];
      config.workflows.default!.stages.implement!.watch = [
        {
          while: { status: ['awaiting-approval'] },
          on: { event: ['wake.run.completed'] },
          schedule: { cron: '*/10 * * * *' },
          workflow: workflowName,
        },
      ];
      config.workflows[workflowName] = {
        stages: {
          review: {
            action,
            workspace: 'read-only',
            tier: 'light',
            onDone: 'done',
          },
        },
      };
      return config;
    }

    // Several fixtures below assert an exact (often empty) set of label
    // events for a narrow scenario (e.g. watcher isolation) that has nothing
    // to do with label reconciliation. Since the reconciliation pass now
    // runs every tick against every item (not only when there's a fresh
    // inbound event), a fixture whose seeded issue.labels don't already match
    // labelsForWorkItem's output would otherwise pick up its own unrelated
    // correction. This re-syncs the seeded labels so only the scenario under
    // test produces label events.
    async function syncLabelsToProjection(
      store: ReturnType<typeof createStateStore>,
      workItemKey: string,
    ) {
      const projection = await store.readIssueState(workItemKey);
      if (projection === null) {
        return;
      }
      const config = createDefaultWakeConfig(root);
      const labels = labelsForWorkItem(projection, config);
      await store.writeIssueState({
        ...projection,
        issue: {
          ...projection.issue,
          labels: [
            ...projection.issue.labels.filter(
              (label) =>
                !label.startsWith('wake:status.') &&
                !label.startsWith('wake:stage.') &&
                !label.startsWith('wake:workflow.'),
            ),
            labels.statusLabel,
            labels.stageLabel,
            labels.workflowLabel,
          ],
        },
      });
    }

    async function seedAwaitingApprovalIssue(input: {
      store: ReturnType<typeof createStateStore>;
      issueNumber: number;
      lastRunId?: string;
      context?: Record<string, unknown>;
      correlatedResources?: IssueStateRecord['correlatedResources'];
      sessionId?: string;
      sessionCli?: string;
      issueState?: 'open' | 'closed';
    }) {
      const lastRunId = input.lastRunId ?? `run-${input.issueNumber}-previous`;
      await input.store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(input.issueNumber),
        issue: {
          repo: 'atolis-hq/wake',
          number: input.issueNumber,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: input.issueState ?? 'open',
          url: `https://example.test/issues/${input.issueNumber}`,
          createdAt: watcherNow,
          updatedAt: watcherNow,
        },
        comments: [],
        wake: {
          stage: 'implement',
          lastRunId,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.sessionCli === undefined ? {} : { sessionCli: input.sessionCli }),
          stageHistory: [],
          recentEventIds: [`${lastRunId}-completed`],
          syncedAt: watcherNow,
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {
          workflow: 'default',
          lastRunSentinel: 'AWAITING_APPROVAL',
          pendingApprovalAction: 'implement',
          ...input.context,
        },
        correlatedResources: input.correlatedResources ?? [],
      });
    }

    async function appendPreviousCompletedEvent(input: {
      store: ReturnType<typeof createStateStore>;
      issueNumber: number;
      runId?: string;
      occurredAt?: string;
      body?: string;
    }) {
      const runId = input.runId ?? `run-${input.issueNumber}-previous`;
      await input.store.appendEventEnvelope(
        createEventEnvelope({
          eventId: `${runId}-completed`,
          workItemKey: workId(input.issueNumber),
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.completed',
          sourceRefs: { repo: 'atolis-hq/wake', issueNumber: input.issueNumber, runId },
          occurredAt: input.occurredAt ?? watcherNow,
          ingestedAt: input.occurredAt ?? watcherNow,
          trigger: 'immediate',
          payload: {
            action: 'implement',
            sentinel: 'AWAITING_APPROVAL',
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        }),
      );
    }

    function prReviewResult(input: {
      status: 'DONE' | 'REJECTED' | 'FAILED' | 'BLOCKED';
      body: string;
      prUrl?: string;
    }) {
      return [
        input.body,
        ...(input.prUrl === undefined
          ? []
          : [
              '',
              '```wake-artifacts',
              `{ "artifacts": [{ "kind": "pr", "url": "${input.prUrl}" }] }`,
              '```',
            ]),
        '',
        '```wake-result',
        `{ "status": "${input.status}" }`,
        '```',
        input.status,
      ].join('\n');
    }

    it('dispatches pr-review from a matching event while awaiting approval without reusing the implement session', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([351]);
      const now = '2026-07-25T12:00:00.000Z';
      const projection: IssueStateRecord = {
        schemaVersion: 1 as const,
        workItemKey: workId(351),
        issue: {
          repo: 'atolis-hq/wake',
          number: 351,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/351',
          createdAt: now,
          updatedAt: now,
        },
        comments: [],
        wake: {
          stage: 'implement',
          lastRunId: 'run-351-previous',
          sessionId: 'implement-session',
          sessionCli: 'Claude',
          stageHistory: [],
          recentEventIds: ['run-351-previous-completed'],
          syncedAt: now,
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {
          workflow: 'default',
          lastRunSentinel: 'AWAITING_APPROVAL',
          pendingApprovalAction: 'implement',
        },
        correlatedResources: [],
      };
      await store.writeIssueState(projection);
      await store.appendEventEnvelope(
        createEventEnvelope({
          eventId: 'run-351-previous-completed',
          workItemKey: workId(351),
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.completed',
          sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 351, runId: 'run-351-previous' },
          occurredAt: now,
          ingestedAt: now,
          trigger: 'immediate',
          payload: { action: 'implement', sentinel: 'AWAITING_APPROVAL' },
        }),
      );

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];
      config.workflows.default!.stages.implement!.watch = [
        {
          while: { status: ['awaiting-approval'] },
          on: { event: ['wake.run.completed'] },
          workflow: 'pr-review',
        },
      ];
      config.workflows['pr-review'] = {
        stages: {
          review: {
            action: 'pr-review',
            workspace: 'read-only',
            tier: 'light',
            onDone: 'done',
          },
        },
      };

      const seen: Array<{ action: string; sessionId?: string; sessionCli?: string }> = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(now) },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run(input) {
            seen.push({
              action: input.action,
              ...(input.projection.wake.sessionId === undefined
                ? {}
                : { sessionId: input.projection.wake.sessionId }),
              ...(input.projection.wake.sessionCli === undefined
                ? {}
                : { sessionCli: input.projection.wake.sessionCli }),
            });
            return {
              result: [
                'Review inconclusive.',
                '',
                '```wake-result',
                '{ "status": "BLOCKED" }',
                '```',
                'BLOCKED',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();
      await tickRunner.runTick();

      expect(seen).toEqual([{ action: 'pr-review', sessionId: undefined, sessionCli: undefined }]);
      const updated = await store.readIssueState(workId(351));
      expect(updated?.wake.stage).toBe('implement');
      expect(updated?.wake.sessionId).toBe('implement-session');
      expect(updated?.context.lastRunSentinel).toBe('AWAITING_APPROVAL');
      const auditEvents = (await store.listEventEnvelopes()).filter(
        (event) => event.sourceEventType === AUTONOMOUS_DECISION_AUDIT_EVENT,
      );
      expect(auditEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              decisionType: 'watcher.dispatched',
              workflowRevision: expect.stringMatching(/^sha256:/),
            }),
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              decisionType: 'review.verdict',
              outcome: expect.objectContaining({ verdict: 'uncertain' }),
            }),
          }),
        ]),
      );
    });

    it('resolves the parent approval gate when an onSuccess.approve watcher child completes DONE without a PR target', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([420]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });
      config.workflows.default!.stages.implement!.watch![0]!.onSuccess = { approve: true };

      await seedAwaitingApprovalIssue({ store, issueNumber: 420 });
      await appendPreviousCompletedEvent({ store, issueNumber: 420 });

      const publishedBodies: string[] = [];
      let runnerCallCount = 0;
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            if (input.event.sourceEventType === 'wake.publish.intent.requested') {
              publishedBodies.push(String(input.event.payload.body));
            }
            return [];
          },
        },
        runner: {
          async run() {
            runnerCallCount += 1;
            return {
              result: prReviewResult({ status: 'DONE', body: 'Plan looks solid.' }),
              model: 'fake',
              cli: 'Fake',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();
      await tickRunner.runTick();

      expect(runnerCallCount).toBe(1);
      const updated = await store.readIssueState(workId(420));
      expect(updated?.wake.stage).toBe('done');
      expect(updated?.context.pendingApprovalAction).toBeUndefined();
      expect(publishedBodies).toContain('Plan looks solid.');
      const events = await store.listEventEnvelopes();
      const approvalEvent = events.find((event) =>
        event.eventId.endsWith('-parent-approval-completed'),
      );
      expect(approvalEvent?.payload.reason).toBe('watcher:approved');
      expect(approvalEvent?.payload.action).toBe('implement');
      const auditEvents = events.filter(
        (event) => event.sourceEventType === AUTONOMOUS_DECISION_AUDIT_EVENT,
      );
      expect(auditEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              decisionType: 'approval.watcher-resolved',
              workflowRevision: expect.stringMatching(/^sha256:/),
            }),
          }),
        ]),
      );
    });

    it('never stamps the child workflow onto the parent issue labels, whether the watcher run succeeds or is rejected', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([425]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });

      await seedAwaitingApprovalIssue({ store, issueNumber: 425 });
      await appendPreviousCompletedEvent({ store, issueNumber: 425 });
      // Pre-sync the parent's actual labels with labelsForWorkItem's output so
      // the every-tick reconciliation pass (unrelated to this test's watcher
      // isolation assertion) finds no drift of its own to correct.
      await syncLabelsToProjection(store, workId(425));

      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
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
              result: prReviewResult({ status: 'BLOCKED', body: 'Not approved as-is.' }),
              model: 'fake',
              cli: 'Fake',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();
      await tickRunner.runTick();

      const events = await store.listEventEnvelopes();
      const labelEvents = events.filter(
        (event) => event.sourceEventType === 'wake.labels.requested',
      );
      // The watcher (plan-review) run claims and completes against the same
      // parent projection, but must never write labels of its own - only the
      // parent's own action (implement, here) is allowed to touch the parent
      // issue's labels.
      expect(labelEvents).toEqual([]);

      const updated = await store.readIssueState(workId(425));
      expect(updated?.wake.stage).toBe('implement');
      expect(updated?.context.lastRunSentinel).toBe('AWAITING_APPROVAL');
    });

    it('does not fold a watcher run infra failure into the parent projection context or labels', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([426]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });

      await seedAwaitingApprovalIssue({ store, issueNumber: 426 });
      await appendPreviousCompletedEvent({ store, issueNumber: 426 });
      await syncLabelsToProjection(store, workId(426));

      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            throw new Error('should not run: workspace prep fails first');
          },
        },
        resourceIndex,
        workspaceManager: {
          async prepareWorkspace() {
            throw new Error('not used');
          },
          async prepareReadOnlyClone() {
            throw new Error('git network failure');
          },
          async recordWorkspaceBookkeeping() {
            throw new Error('not used');
          },
          async cleanupWorkspace() {},
        },
      });

      await tickRunner.runTick();

      const events = await store.listEventEnvelopes();
      const labelEvents = events.filter(
        (event) => event.sourceEventType === 'wake.labels.requested',
      );
      expect(labelEvents).toEqual([]);

      const updated = await store.readIssueState(workId(426));
      // The watcher's own infra failure must not overwrite the parent's real
      // status - it's still sitting on the original implement approval gate,
      // untouched by the child review workflow dying before it could run.
      expect(updated?.wake.stage).toBe('implement');
      expect(updated?.context.lastRunSentinel).toBe('AWAITING_APPROVAL');
      expect(updated?.context.pendingApprovalAction).toBe('implement');
    });

    it('threads the triggering completion event body into the watcher child prompt context, not just projection.comments', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([424]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });
      // Event-only trigger: a schedule fallback would also fire on the second
      // tick with no triggering event of its own, overwriting the assertion
      // below with an empty override — not what this test is checking.
      delete config.workflows.default!.stages.implement!.watch![0]!.schedule;

      await seedAwaitingApprovalIssue({ store, issueNumber: 424 });
      await appendPreviousCompletedEvent({
        store,
        issueNumber: 424,
        body: 'Proposed plan: rename foo to bar.',
      });

      let seenContextOverrides: Record<string, unknown> | undefined;
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run(input) {
            seenContextOverrides = input.promptContextOverrides;
            return {
              result: prReviewResult({ status: 'BLOCKED', body: 'Needs a human look.' }),
              model: 'fake',
              cli: 'Fake',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      expect(seenContextOverrides?.parentPendingReviewBody).toBe(
        'Proposed plan: rename foo to bar.',
      );
    });

    it('does not resolve the parent gate when the watcher lacks onSuccess.approve', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([421]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });

      await seedAwaitingApprovalIssue({ store, issueNumber: 421 });
      await appendPreviousCompletedEvent({ store, issueNumber: 421 });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
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
              result: prReviewResult({ status: 'DONE', body: 'Plan looks solid.' }),
              model: 'fake',
              cli: 'Fake',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();
      await tickRunner.runTick();

      const updated = await store.readIssueState(workId(421));
      expect(updated?.wake.stage).toBe('implement');
      expect(updated?.context.pendingApprovalAction).toBe('implement');
      const events = await store.listEventEnvelopes();
      expect(
        events.find((event) => event.eventId.endsWith('-parent-approval-completed')),
      ).toBeUndefined();
    });

    it('publishes a REJECTED child verdict without approving the parent gate', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([422]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });
      config.workflows.default!.stages.implement!.watch![0]!.onSuccess = { approve: true };

      await seedAwaitingApprovalIssue({ store, issueNumber: 422 });
      await appendPreviousCompletedEvent({ store, issueNumber: 422 });

      const publishedBodies: string[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            if (input.event.sourceEventType === 'wake.publish.intent.requested') {
              publishedBodies.push(String(input.event.payload.body));
            }
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: prReviewResult({
                status: 'REJECTED',
                body: 'Plan misses the rollback path.',
              }),
              model: 'fake',
              cli: 'Fake',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      // A single tick only dispatches and completes the watcher run itself —
      // the auto-revise re-dispatch of the parent's pending action happens on
      // a *later* tick (see 'auto-revises the original pending action after
      // a changes-requested watcher rejection' below), so this only asserts
      // the watcher-run completion's own effect on the parent.
      await tickRunner.runTick();

      const updated = await store.readIssueState(workId(422));
      expect(updated?.wake.stage).toBe('implement');
      expect(updated?.context.pendingApprovalAction).toBe('implement');
      expect(updated?.context.status).toBe('changes-requested');
      expect(updated?.context.changesRequestedCount).toBe(1);
      expect(updated?.context.changesRequestedFeedback).toBe('Plan misses the rollback path.');
      expect(publishedBodies).toContain('Plan misses the rollback path.');
      const events = await store.listEventEnvelopes();
      expect(
        events.find((event) => event.eventId.endsWith('-parent-approval-completed')),
      ).toBeUndefined();
    });

    it('does not fold a BLOCKED or FAILED child verdict into changes-requested (only REJECTED is a review rejection)', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([423]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });
      config.workflows.default!.stages.implement!.watch![0]!.onSuccess = { approve: true };

      await seedAwaitingApprovalIssue({ store, issueNumber: 423 });
      await appendPreviousCompletedEvent({ store, issueNumber: 423 });

      const publishedBodies: string[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            if (input.event.sourceEventType === 'wake.publish.intent.requested') {
              publishedBodies.push(String(input.event.payload.body));
            }
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: prReviewResult({
                status: 'BLOCKED',
                body: 'This needs operator judgment on the schema migration.',
              }),
              model: 'fake',
              cli: 'Fake',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const updated = await store.readIssueState(workId(423));
      expect(updated?.wake.stage).toBe('implement');
      expect(updated?.context.pendingApprovalAction).toBe('implement');
      // BLOCKED means the reviewer couldn't render a verdict at all — it must
      // not be treated as "reviewed and rejected." A non-rejecting watcher
      // run leaves the parent's context untouched (same as seedAwaitingApprovalIssue
      // left it — it never sets context.status), so no changes-requested loop
      // is started.
      expect(updated?.context.status).toBeUndefined();
      expect(updated?.context.changesRequestedCount ?? 0).toBe(0);
      expect(publishedBodies).toContain('This needs operator judgment on the schema migration.');
      const events = await store.listEventEnvelopes();
      expect(
        events.find((event) => event.eventId.endsWith('-parent-approval-completed')),
      ).toBeUndefined();
    });

    it('auto-revises the original pending action after a changes-requested watcher rejection, then resolves the gate once plan-review approves', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([424]);
      const config = configurePrReviewWatcher(root, {
        workflowName: 'plan-review',
        action: 'plan-review',
      });
      config.workflows.default!.stages.implement!.watch![0]!.onSuccess = { approve: true };

      await seedAwaitingApprovalIssue({ store, issueNumber: 424 });
      await appendPreviousCompletedEvent({ store, issueNumber: 424 });

      const labelEvents: Array<{ statusLabel: string }> = [];
      let planReviewCalls = 0;
      let implementCalls = 0;
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            if (input.event.sourceEventType === 'wake.labels.requested') {
              labelEvents.push({ statusLabel: String(input.event.payload.statusLabel) });
            }
            return [];
          },
        },
        runner: {
          async run(input) {
            if (input.action === 'plan-review') {
              planReviewCalls += 1;
              return planReviewCalls === 1
                ? {
                    result: prReviewResult({ status: 'REJECTED', body: 'Please add tests.' }),
                    model: 'fake',
                    cli: 'Fake',
                  }
                : {
                    result: prReviewResult({ status: 'DONE', body: 'Looks good now.' }),
                    model: 'fake',
                    cli: 'Fake',
                  };
            }
            implementCalls += 1;
            expect(input.promptContextOverrides?.parentPendingReviewBody).toBe('Please add tests.');
            return {
              result: 'Added tests.\nDONE',
              model: 'fake',
              cli: 'Fake',
              metadata: { skipApproval: false },
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      // Tick 1: plan-review watcher rejects the plan.
      await tickRunner.runTick();
      let updated = await store.readIssueState(workId(424));
      expect(updated?.wake.stage).toBe('implement');
      expect(updated?.context.status).toBe('changes-requested');
      expect(updated?.context.changesRequestedCount).toBe(1);

      // Tick 2: no eligible watcher event yet, so the parent's own
      // changes-requested status is now actionable — auto re-dispatches the
      // original pending action ('implement') with the feedback threaded.
      await tickRunner.runTick();
      updated = await store.readIssueState(workId(424));
      expect(implementCalls).toBe(1);
      expect(updated?.context.status).toBe('awaiting-approval');
      expect(updated?.context.changesRequestedCount).toBe(1);

      // Tick 3: the revise run's own completion re-triggers the plan-review
      // watcher, which now approves, resolving the parent's gate to 'done'.
      await tickRunner.runTick();
      updated = await store.readIssueState(workId(424));
      expect(planReviewCalls).toBe(2);
      expect(updated?.wake.stage).toBe('done');

      expect(labelEvents.map((event) => event.statusLabel)).toContain(
        'wake:status.changes-requested',
      );
    });

    it('publishes a pr-review approval marker only after the reported PR verifies and belongs to the work item', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([352]);
      const now = '2026-07-25T12:00:00.000Z';
      await resourceIndex.register('github:pr:atolis-hq/wake#99', workId(352));
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(352),
        issue: {
          repo: 'atolis-hq/wake',
          number: 352,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/352',
          createdAt: now,
          updatedAt: now,
        },
        comments: [],
        wake: {
          stage: 'implement',
          lastRunId: 'run-352-previous',
          stageHistory: [],
          recentEventIds: ['run-352-previous-completed'],
          syncedAt: now,
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {
          workflow: 'default',
          lastRunSentinel: 'AWAITING_APPROVAL',
          pendingApprovalAction: 'implement',
        },
        correlatedResources: [
          {
            resourceUri: 'github:pr:atolis-hq/wake#99',
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: now,
          },
        ],
      });
      await store.appendEventEnvelope(
        createEventEnvelope({
          eventId: 'run-352-previous-completed',
          workItemKey: workId(352),
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.completed',
          sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 352, runId: 'run-352-previous' },
          occurredAt: now,
          ingestedAt: now,
          trigger: 'immediate',
          payload: { action: 'implement', sentinel: 'AWAITING_APPROVAL' },
        }),
      );

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];
      config.workflows.default!.stages.implement!.watch = [
        {
          while: { status: ['awaiting-approval'] },
          on: { event: ['wake.run.completed'] },
          workflow: 'pr-review',
        },
      ];
      config.workflows['pr-review'] = {
        stages: {
          review: {
            action: 'pr-review',
            workspace: 'read-only',
            tier: 'light',
            onDone: 'done',
          },
        },
      };

      const delivered: EventEnvelope[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(now) },
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
                'Safe to merge.',
                '',
                '```wake-artifacts',
                '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/atolis-hq/wake/pull/99" }] }',
                '```',
                '',
                '```wake-result',
                '{ "status": "DONE" }',
                '```',
                'DONE',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            delivered.push(input.event);
            return [];
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier: createFakeArtifactVerifier({
          verifies: [
            {
              url: 'https://example.test/atolis-hq/wake/pull/99',
              resourceUri: 'github:pr:atolis-hq/wake#99',
            },
          ],
        }),
      });

      await tickRunner.runTick();

      const verdict = delivered.find(
        (event) =>
          event.sourceRefs.resourceUri === 'github:pr:atolis-hq/wake#99' &&
          typeof event.payload.body === 'string' &&
          event.payload.body.includes('<!-- wake:pr-review-approved -->'),
      );
      expect(verdict?.sourceRefs.resourceUri).toBe('github:pr:atolis-hq/wake#99');
      expect(verdict?.payload.kind).toBe('status-update');
      expect(verdict?.payload.body).toContain('<!-- wake:pr-review-approved -->');
      const auditVerdict = (await store.listEventEnvelopes()).find(
        (event) =>
          event.sourceEventType === AUTONOMOUS_DECISION_AUDIT_EVENT &&
          event.payload.decisionType === 'review.verdict',
      );
      expect(auditVerdict?.payload.outcome).toMatchObject({
        verdict: 'approved',
      });
      expect(
        String((auditVerdict?.payload.outcome as { reasoning?: unknown })?.reasoning),
      ).toContain('Safe to merge.');
    });

    it('publishes a pr-review changes-requested marker for a REJECTED verdict on a confirmed PR', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([353]);
      await resourceIndex.register('github:pr:atolis-hq/wake#353', workId(353));
      await seedAwaitingApprovalIssue({
        store,
        issueNumber: 353,
        correlatedResources: [
          {
            resourceUri: 'github:pr:atolis-hq/wake#353',
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: watcherNow,
          },
        ],
      });
      await appendPreviousCompletedEvent({ store, issueNumber: 353 });

      const delivered: EventEnvelope[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config: configurePrReviewWatcher(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            delivered.push(input.event);
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: prReviewResult({
                status: 'REJECTED',
                body: 'Tests are missing the negative path.',
                prUrl: 'https://example.test/atolis-hq/wake/pull/353',
              }),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier: createFakeArtifactVerifier({
          verifies: [
            {
              url: 'https://example.test/atolis-hq/wake/pull/353',
              resourceUri: 'github:pr:atolis-hq/wake#353',
            },
          ],
        }),
      });

      const result = await tickRunner.runTick();

      expect(result.status).toBe('processed');
      expect((result as { sentinel?: string }).sentinel).toBe('REJECTED');
      const verdict = delivered.find(
        (event) => event.sourceRefs.resourceUri === 'github:pr:atolis-hq/wake#353',
      );
      expect(verdict?.payload.kind).toBe('status-update');
      expect(verdict?.payload.body).toContain('<!-- wake:pr-review-changes-requested -->');
      expect(verdict?.payload.body).not.toContain('<!-- wake:pr-review-approved -->');
    });

    it('suppresses pr-review output for an uncertain verdict instead of posting to the PR', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([354]);
      await resourceIndex.register('github:pr:atolis-hq/wake#354', workId(354));
      await seedAwaitingApprovalIssue({ store, issueNumber: 354 });
      await appendPreviousCompletedEvent({ store, issueNumber: 354 });

      const delivered: EventEnvelope[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config: configurePrReviewWatcher(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            delivered.push(input.event);
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: prReviewResult({
                status: 'BLOCKED',
                body: 'The diff is too ambiguous to approve or request changes.',
                prUrl: 'https://example.test/atolis-hq/wake/pull/354',
              }),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier: createFakeArtifactVerifier({
          verifies: [
            {
              url: 'https://example.test/atolis-hq/wake/pull/354',
              resourceUri: 'github:pr:atolis-hq/wake#354',
            },
          ],
        }),
      });

      const result = await tickRunner.runTick();
      const events = await store.listEventEnvelopes();

      expect(result.status).toBe('processed');
      expect((result as { sentinel?: string }).sentinel).toBe('BLOCKED');
      expect(
        delivered.some((event) => event.sourceRefs.resourceUri === 'github:pr:atolis-hq/wake#354'),
      ).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          sourceEventType: 'wake.publish.intent.requested',
          payload: expect.objectContaining({
            deliveryState: 'CONFIRMED',
            suppressedPublishReason: 'pr-review-no-actionable-verdict',
          }),
        }),
      );
    });

    it('registers an uncorrelated verified PR before acting on a pr-review approval verdict', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([355]);
      await seedAwaitingApprovalIssue({ store, issueNumber: 355 });
      await appendPreviousCompletedEvent({ store, issueNumber: 355 });

      const delivered: EventEnvelope[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config: configurePrReviewWatcher(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            delivered.push(input.event);
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: prReviewResult({
                status: 'DONE',
                body: 'Safe to merge.',
                prUrl: 'https://example.test/atolis-hq/wake/pull/355',
              }),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier: createFakeArtifactVerifier({
          verifies: [
            {
              url: 'https://example.test/atolis-hq/wake/pull/355',
              resourceUri: 'github:pr:atolis-hq/wake#355',
            },
          ],
        }),
      });

      await tickRunner.runTick();

      const projection = await store.readIssueState(workId(355));
      expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#355')).toBe(workId(355));
      expect(projection?.correlatedResources).toContainEqual(
        expect.objectContaining({
          resourceUri: 'github:pr:atolis-hq/wake#355',
          role: 'implementation',
          relation: 'primary',
        }),
      );
      expect(
        delivered.some(
          (event) =>
            event.sourceRefs.resourceUri === 'github:pr:atolis-hq/wake#355' &&
            typeof event.payload.body === 'string' &&
            event.payload.body.includes('<!-- wake:pr-review-approved -->'),
        ),
      ).toBe(true);
    });

    it('registers an uncorrelated verified PR from a watcher action not named pr-review', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([359]);
      await seedAwaitingApprovalIssue({ store, issueNumber: 359 });
      await appendPreviousCompletedEvent({ store, issueNumber: 359 });

      const delivered: EventEnvelope[] = [];
      const seenActions: string[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config: configurePrReviewWatcher(root, {
          workflowName: 'merge-advice',
          action: 'merge-advice',
        }),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            delivered.push(input.event);
            return [];
          },
        },
        runner: {
          async run(input) {
            seenActions.push(input.action);
            return {
              result: prReviewResult({
                status: 'DONE',
                body: 'Safe to merge.',
                prUrl: 'https://example.test/atolis-hq/wake/pull/359',
              }),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier: createFakeArtifactVerifier({
          verifies: [
            {
              url: 'https://example.test/atolis-hq/wake/pull/359',
              resourceUri: 'github:pr:atolis-hq/wake#359',
            },
          ],
        }),
      });

      await tickRunner.runTick();

      const projection = await store.readIssueState(workId(359));
      expect(seenActions).toEqual(['merge-advice']);
      expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#359')).toBe(workId(359));
      expect(projection?.correlatedResources).toContainEqual(
        expect.objectContaining({
          resourceUri: 'github:pr:atolis-hq/wake#359',
          role: 'implementation',
          relation: 'primary',
        }),
      );
      expect(
        delivered.some(
          (event) =>
            event.sourceRefs.resourceUri === 'github:pr:atolis-hq/wake#359' &&
            typeof event.payload.body === 'string' &&
            event.payload.body.includes('<!-- wake:pr-review-approved -->'),
        ),
      ).toBe(true);
    });

    it('refuses a pr-review verdict for a PR primary-correlated to a different work item', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([356, 999]);
      await resourceIndex.register('github:pr:atolis-hq/wake#356', workId(999));
      await seedAwaitingApprovalIssue({ store, issueNumber: 356 });
      await appendPreviousCompletedEvent({ store, issueNumber: 356 });

      const delivered: EventEnvelope[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date(watcherNow) },
        config: configurePrReviewWatcher(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent(input) {
            delivered.push(input.event);
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: prReviewResult({
                status: 'DONE',
                body: 'Safe to merge.',
                prUrl: 'https://example.test/atolis-hq/wake/pull/356',
              }),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier: createFakeArtifactVerifier({
          verifies: [
            {
              url: 'https://example.test/atolis-hq/wake/pull/356',
              resourceUri: 'github:pr:atolis-hq/wake#356',
            },
          ],
        }),
      });

      await tickRunner.runTick();

      const events = await store.listEventEnvelopes();
      expect(
        delivered.some((event) => event.sourceRefs.resourceUri === 'github:pr:atolis-hq/wake#356'),
      ).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({
          sourceEventType: 'wake.correlation.primary-conflict',
          payload: expect.objectContaining({
            resourceUri: 'github:pr:atolis-hq/wake#356',
            incumbentWorkItemKey: workId(999),
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          sourceEventType: 'wake.publish.intent.requested',
          payload: expect.objectContaining({
            deliveryState: 'CONFIRMED',
            suppressedPublishReason: 'pr-review-no-actionable-verdict',
          }),
        }),
      );
    });

    it('dispatches pr-review from a matching schedule while the watched stage remains awaiting approval', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([357]);
      await seedAwaitingApprovalIssue({ store, issueNumber: 357 });

      const seenTriggers: unknown[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-25T12:34:30.000Z') },
        config: configurePrReviewWatcher(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: prReviewResult({
                status: 'BLOCKED',
                body: 'No clear verdict.',
              }),
              model: 'fake',
              cli: 'Fake',
              session_id: 'review-session',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const runRecords = await store.listRunRecords();
      for (const record of runRecords) {
        seenTriggers.push(record.metadata?.watcherTrigger);
      }
      expect(seenTriggers).toEqual([{ kind: 'schedule', slot: '2026-07-25T12:30:00.000Z' }]);
    });

    it('does not dispatch a watcher while another run is still in flight', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([358]);
      await seedAwaitingApprovalIssue({ store, issueNumber: 358 });
      await appendPreviousCompletedEvent({ store, issueNumber: 358 });
      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-358-active-review',
        workItemKey: workId(358),
        repo: 'atolis-hq/wake',
        issueNumber: 358,
        action: 'pr-review',
        lifecycle: 'RUNNING',
        status: 'running',
        startedAt: '2026-07-25T12:00:00.000Z',
        lease: {
          leaseId: 'lease-358-active-review',
          ownerInstanceId: 'other-instance',
          acquiredAt: '2026-07-25T12:00:00.000Z',
          lastRenewedAt: '2026-07-25T12:04:00.000Z',
          expiresAt: '2026-07-25T12:15:00.000Z',
        },
      });

      let runnerCalls = 0;
      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-25T12:05:00.000Z') },
        config: configurePrReviewWatcher(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            runnerCalls += 1;
            return { result: 'should not run\nDONE', model: 'fake', cli: 'Fake' };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const runRecords = await store.listRunRecords();
      const events = await store.listEventEnvelopes();

      expect(result.status).toBe('idle');
      expect(runnerCalls).toBe(0);
      expect(runRecords).toHaveLength(1);
      expect(events.some((event) => event.sourceEventType === 'wake.run.claimed')).toBe(false);
    });

    it('does not dispatch a watcher from a watcher run completion event', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([359]);
      await seedAwaitingApprovalIssue({ store, issueNumber: 359 });
      await store.appendEventEnvelope(
        createEventEnvelope({
          eventId: 'run-359-review-completed',
          workItemKey: workId(359),
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.completed',
          sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 359, runId: 'run-359-review' },
          occurredAt: '2026-07-25T12:10:00.000Z',
          ingestedAt: '2026-07-25T12:10:00.000Z',
          trigger: 'immediate',
          payload: {
            action: 'pr-review',
            sentinel: 'BLOCKED',
            watcherRun: true,
            watcherTrigger: { kind: 'event', eventId: 'run-359-previous-completed' },
          },
        }),
      );

      const config = configurePrReviewWatcher(root);
      config.workflows.default!.stages.implement!.watch![0]!.schedule = undefined;
      let runnerCalls = 0;
      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-25T12:11:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            runnerCalls += 1;
            return { result: 'should not run\nDONE', model: 'fake', cli: 'Fake' };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();

      expect(result.status).toBe('idle');
      expect(runnerCalls).toBe(0);
      expect(await store.listRunRecords()).toHaveLength(0);
    });

    it('runs revise instead of re-running pr-review after a changes-requested marker', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([360]);
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(360),
        issue: {
          repo: 'atolis-hq/wake',
          number: 360,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/360',
          createdAt: watcherNow,
          updatedAt: watcherNow,
        },
        comments: [
          {
            id: 'pr-5084905755',
            body: 'Please revise this PR.\n\n<!-- wake:pr-review-changes-requested -->',
            author: { login: 'atolis-hq-agent' },
            createdAt: '2026-07-25T12:10:00.000Z',
            updatedAt: '2026-07-25T12:10:00.000Z',
            isBotAuthored: true,
            resourceUri: 'github:pr:atolis-hq/wake#410',
          },
          {
            id: 'pr-5084954595',
            body: 'address the comments\nand fix the failing tests',
            author: { login: 'jmenziessmith' },
            createdAt: '2026-07-25T12:11:00.000Z',
            updatedAt: '2026-07-25T12:11:00.000Z',
            isBotAuthored: false,
            resourceUri: 'github:pr:atolis-hq/wake#410',
          },
        ],
        wake: {
          stage: 'implement',
          lastRunId: 'run-360-previous',
          stageHistory: [],
          recentEventIds: ['run-360-review-completed'],
          syncedAt: watcherNow,
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {
          workflow: 'default',
          lastRunSentinel: 'AWAITING_APPROVAL',
          pendingApprovalAction: 'implement',
        },
        correlatedResources: [
          {
            resourceUri: 'github:pr:atolis-hq/wake#410',
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: watcherNow,
          },
        ],
      });
      await store.appendEventEnvelope(
        createEventEnvelope({
          eventId: 'run-360-review-completed',
          workItemKey: workId(360),
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.completed',
          sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 360, runId: 'run-360-review' },
          occurredAt: '2026-07-25T12:10:00.000Z',
          ingestedAt: '2026-07-25T12:10:00.000Z',
          trigger: 'immediate',
          payload: {
            action: 'pr-review',
            sentinel: 'FAILED',
            watcherRun: true,
            watcherTrigger: { kind: 'event', eventId: 'run-360-previous-completed' },
          },
        }),
      );

      const config = configurePrReviewWatcher(root);
      config.workflows.default!.stages.implement!.watch![0]!.schedule = undefined;
      const seen: string[] = [];
      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-25T12:11:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run(input) {
            seen.push(input.action);
            return {
              result: [
                'Revised and awaiting approval.',
                '',
                '```wake-result',
                '{ "status": "AWAITING_APPROVAL" }',
                '```',
                'AWAITING_APPROVAL',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
            };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const revised = await store.readIssueState(workId(360));
      await tickRunner.runTick();

      expect(result.status).toBe('processed');
      expect(revised?.context.lastHandledCommentId).toBe('pr-5084954595');
      expect(seen.filter((action) => action === 'revise')).toEqual(['revise']);
    });

    it('does not dispatch a watcher for a closed issue even while its stale local status still matches', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([361]);
      await seedAwaitingApprovalIssue({ store, issueNumber: 361, issueState: 'closed' });

      let runnerCalls = 0;
      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-25T12:34:30.000Z') },
        config: configurePrReviewWatcher(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            runnerCalls += 1;
            return { result: 'should not run\nDONE', model: 'fake', cli: 'Fake' };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();

      expect(result.status).toBe('idle');
      expect(runnerCalls).toBe(0);
      expect(await store.listRunRecords()).toHaveLength(0);
    });

    it('blocks dispatch once the trailing-window run-record count reaches the configured ceiling', async () => {
      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = await seededResourceIndex([360]);
      await seedAwaitingApprovalIssue({ store, issueNumber: 360 });
      await appendPreviousCompletedEvent({ store, issueNumber: 360 });
      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-360-earlier-this-hour',
        workItemKey: workId(360),
        repo: 'atolis-hq/wake',
        issueNumber: 360,
        action: 'pr-review',
        lifecycle: 'TERMINAL',
        status: 'completed',
        startedAt: '2026-07-25T12:00:00.000Z',
        // Rate-limit counting reads run records via the summarized listing
        // (state-store.ts stripHeavyRunRecordFields) so the resident loop
        // doesn't hold every run's captured stdout/raw in memory each tick -
        // a large metadata payload here proves that stripping doesn't affect
        // whether this record still counts toward the window.
        metadata: { stdout: 'x'.repeat(10_000) },
      });

      const config = configurePrReviewWatcher(root);
      config.scheduler.dispatchRateLimit = { windowMs: 60 * 60 * 1000, maxDispatches: 1 };

      let runnerCalls = 0;
      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-25T12:34:30.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            runnerCalls += 1;
            return { result: 'should not run\nDONE', model: 'fake', cli: 'Fake' };
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const events = await store.listEventEnvelopes();

      expect(result.status).toBe('idle');
      expect(runnerCalls).toBe(0);
      expect(await store.listRunRecords()).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.sourceEventType === AUTONOMOUS_DECISION_AUDIT_EVENT &&
            (event.payload as { decisionType?: string }).decisionType === 'dispatch.rate-limited',
        ),
      ).toBe(true);
    });
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
          lastRetrySafety: 'SAFE_TO_RETRY',
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
    }, 20_000);
  });
});
