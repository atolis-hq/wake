import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { stageLabelForStage, stageValues } from '../../src/domain/stages.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

function issueUpsert(input: {
  eventId: string;
  issueNumber: number;
  labels: string[];
  occurredAt?: string;
  ingestedAt?: string;
}) {
  const occurredAt = input.occurredAt ?? '2026-07-05T12:00:00.000Z';
  const ingestedAt = input.ingestedAt ?? occurredAt;

  return createEventEnvelope({
    eventId: input.eventId,
    workItemKey: `atolis-hq/wake#${input.issueNumber}`,
    streamScope: 'global-intake',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: 'ticket.upsert',
    sourceRefs: {
      repo: 'atolis-hq/wake',
      issueNumber: input.issueNumber,
      sourceUrl: `https://example.test/issues/${input.issueNumber}`,
    },
    occurredAt,
    ingestedAt,
    trigger: 'immediate',
    payload: {
      ticket: {
        repo: 'atolis-hq/wake',
        number: input.issueNumber,
        title: 'Example',
        body: 'Body',
        labels: input.labels,
        assignees: [],
        state: 'open',
        url: `https://example.test/issues/${input.issueNumber}`,
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: occurredAt,
      },
    },
  });
}

describe('projection updater', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-projection-updater-'));
  });

  it('builds a work-item projection from correlated event envelopes', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const events = [
      createEventEnvelope({
        eventId: 'evt-issue',
        workItemKey: 'atolis-hq/wake#7',
        streamScope: 'global-intake',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.upsert',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 7,
          sourceUrl: 'https://example.test/issues/7',
        },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:01.000Z',
        trigger: 'immediate',
        payload: {
          issue: {
            repo: 'atolis-hq/wake',
            number: 7,
            title: 'Example',
            body: 'Body',
            labels: ['wake:queue'],
            assignees: [],
            state: 'open',
            url: 'https://example.test/issues/7',
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
        },
      }),
      createEventEnvelope({
        eventId: 'evt-comment',
        workItemKey: 'atolis-hq/wake#7',
        streamScope: 'work-item',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.comment.created',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 7,
          commentId: 'c-1',
        },
        occurredAt: '2026-07-05T12:05:00.000Z',
        ingestedAt: '2026-07-05T12:05:01.000Z',
        trigger: 'context-only',
        payload: {
          comment: {
            id: 'c-1',
            body: 'Need more detail',
            author: { login: 'shared-user' },
            createdAt: '2026-07-05T12:05:00.000Z',
            updatedAt: '2026-07-05T12:05:00.000Z',
          },
        },
        derivedHints: {
        },
      }),
    ];

    for (const event of events) {
      await store.appendEventEnvelope(event);
    }

    await updater.rebuildFromEvents(events);

    const projection = await store.readIssueState('atolis-hq/wake', 7);
    expect(projection?.workItemKey).toBe('atolis-hq/wake#7');
    expect(projection?.latestComment?.id).toBe('c-1');
    expect(projection?.wake.recentEventIds).toEqual(['evt-issue', 'evt-comment']);
  });

  it('sets the initial projection stage from each current wake stage label', async () => {
    for (const [index, stage] of stageValues.entries()) {
      const store = createStateStore({
        wakeRoot: await mkdtemp(join(tmpdir(), 'wake-projection-updater-stage-')),
      });
      const updater = createProjectionUpdater({ stateStore: store });
      const event = issueUpsert({
        eventId: `evt-stage-${stage}`,
        issueNumber: 100 + index,
        labels: ['bug', stageLabelForStage(stage)],
      });

      await updater.rebuildFromEvents([event]);

      const projection = await store.readIssueState('atolis-hq/wake', 100 + index);
      expect(projection?.wake.stage).toBe(stage);
    }
  });

  it('ignores legacy and unknown stage labels when creating a projection', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });
    const event = issueUpsert({
      eventId: 'evt-legacy-label',
      issueNumber: 101,
      labels: ['wake:refined', 'wake:stage.nope'],
    });

    await updater.rebuildFromEvents([event]);

    const projection = await store.readIssueState('atolis-hq/wake', 101);
    expect(projection?.wake.stage).toBe('queue');
  });

  it('does not set stage from ambiguous current wake stage labels', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });
    const event = issueUpsert({
      eventId: 'evt-ambiguous-labels',
      issueNumber: 102,
      labels: [stageLabelForStage('refined'), stageLabelForStage('blocked')],
    });

    await updater.rebuildFromEvents([event]);

    const projection = await store.readIssueState('atolis-hq/wake', 102);
    expect(projection?.wake.stage).toBe('queue');
  });

  it('reconciles an existing projection stage from a single current wake stage label', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });
    const initial = issueUpsert({
      eventId: 'evt-reconcile-initial',
      issueNumber: 103,
      labels: [stageLabelForStage('refined')],
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
    });
    const reconciled = issueUpsert({
      eventId: 'evt-reconcile-updated',
      issueNumber: 103,
      labels: [stageLabelForStage('blocked')],
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:01.000Z',
    });

    await updater.rebuildFromEvents([initial]);
    await updater.rebuildFromEvents([reconciled]);

    const projection = await store.readIssueState('atolis-hq/wake', 103);
    expect(projection?.wake.stage).toBe('blocked');
    expect(projection?.wake.stageHistory).toEqual([
      {
        stage: 'blocked',
        changedAt: '2026-07-05T12:05:00.000Z',
        reason: 'github-label-sync',
      },
    ]);
  });

  it('leaves an existing projection stage unchanged for ambiguous current wake stage labels', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });
    const initial = issueUpsert({
      eventId: 'evt-ambiguous-existing-initial',
      issueNumber: 104,
      labels: [stageLabelForStage('refined')],
    });
    const ambiguous = issueUpsert({
      eventId: 'evt-ambiguous-existing-updated',
      issueNumber: 104,
      labels: [stageLabelForStage('active'), stageLabelForStage('blocked')],
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:01.000Z',
    });

    await updater.rebuildFromEvents([initial]);
    await updater.rebuildFromEvents([ambiguous]);

    const projection = await store.readIssueState('atolis-hq/wake', 104);
    expect(projection?.wake.stage).toBe('refined');
    expect(projection?.wake.stageHistory).toEqual([]);
  });

  it('does not regress an already-advanced stage when the issue is re-synced', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-1',
      workItemKey: 'atolis-hq/wake#9',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 9,
        sourceUrl: 'https://example.test/issues/9',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 9,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/9',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });

    await store.appendEventEnvelope(initialUpsert);
    await updater.rebuildFromEvents([initialUpsert]);

    const runCompleted = createEventEnvelope({
      eventId: 'evt-run-completed',
      workItemKey: 'atolis-hq/wake#9',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.run.completed',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 9,
        runId: 'run-9-1',
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'immediate',
      payload: {
        nextStage: 'refined',
        runId: 'run-9-1',
      },
    });

    await store.appendEventEnvelope(runCompleted);
    await updater.rebuildFromEvents([runCompleted]);

    let projection = await store.readIssueState('atolis-hq/wake', 9);
    expect(projection?.wake.stage).toBe('refined');

    // Wake's own status comment bumps the GitHub issue's updatedAt, which
    // causes the next poll to re-ingest a ticket.upsert with no labels applied.
    const resync = createEventEnvelope({
      eventId: 'evt-issue-2',
      workItemKey: 'atolis-hq/wake#9',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 9,
        sourceUrl: 'https://example.test/issues/9',
      },
      occurredAt: '2026-07-05T12:02:00.000Z',
      ingestedAt: '2026-07-05T12:02:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 9,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/9',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:02:00.000Z',
        },
      },
    });

    await store.appendEventEnvelope(resync);
    await updater.rebuildFromEvents([resync]);

    projection = await store.readIssueState('atolis-hq/wake', 9);
    expect(projection?.wake.stage).toBe('refined');
  });

  it('records published comment ids as expected echoes', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-echo-comment',
      workItemKey: 'atolis-hq/wake#10',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 10,
        sourceUrl: 'https://example.test/issues/10',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 10,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/10',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });
    const published = createEventEnvelope({
      eventId: 'evt-comment-published',
      workItemKey: 'atolis-hq/wake#10',
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.reply.published',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 10,
        commentId: 'c-wake',
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'context-only',
      payload: {},
    });

    await updater.rebuildFromEvents([initialUpsert, published]);

    const projection = await store.readIssueState('atolis-hq/wake', 10);
    expect(projection?.wake.expectedEcho.commentIds).toEqual(['c-wake']);
  });

  it('records updated labels as expected echoes and refreshes local labels', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-echo-label',
      workItemKey: 'atolis-hq/wake#11',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 11,
        sourceUrl: 'https://example.test/issues/11',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 11,
          title: 'Example',
          body: 'Body',
          labels: ['bug', 'wake:status.pending'],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/11',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });
    const labelsUpdated = createEventEnvelope({
      eventId: 'evt-labels-updated',
      workItemKey: 'atolis-hq/wake#11',
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.labels.updated',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 11,
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'context-only',
      payload: {
        labels: ['bug', 'wake:status.working', 'wake:stage.queue'],
      },
    });

    await updater.rebuildFromEvents([initialUpsert, labelsUpdated]);

    const projection = await store.readIssueState('atolis-hq/wake', 11);
    expect(projection?.issue.labels).toEqual([
      'bug',
      'wake:status.working',
      'wake:stage.queue',
    ]);
    expect(projection?.wake.expectedEcho.labels).toEqual([
      'bug',
      'wake:status.working',
      'wake:stage.queue',
    ]);
  });

  it('records a human reply on a blocked issue without changing stage', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-1',
      workItemKey: 'atolis-hq/wake#20',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 20,
        sourceUrl: 'https://example.test/issues/20',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 20,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/20',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });

    await store.appendEventEnvelope(initialUpsert);
    await updater.rebuildFromEvents([initialUpsert]);

    const runCompleted = createEventEnvelope({
      eventId: 'evt-run-completed',
      workItemKey: 'atolis-hq/wake#20',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.run.completed',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 20,
        runId: 'run-20-1',
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'immediate',
      payload: {
        nextStage: 'blocked',
        runId: 'run-20-1',
      },
    });

    await store.appendEventEnvelope(runCompleted);
    await updater.rebuildFromEvents([runCompleted]);

    let projection = await store.readIssueState('atolis-hq/wake', 20);
    expect(projection?.wake.stage).toBe('blocked');

    const wakeQuestionComment = createEventEnvelope({
      eventId: 'evt-comment-wake',
      workItemKey: 'atolis-hq/wake#20',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 20,
        commentId: 'c-wake',
      },
      occurredAt: '2026-07-05T12:01:30.000Z',
      ingestedAt: '2026-07-05T12:01:31.000Z',
      trigger: 'context-only',
      payload: {
        comment: {
          id: 'c-wake',
          body: 'I need more info',
          author: { login: 'wake-bot' },
          createdAt: '2026-07-05T12:01:30.000Z',
          updatedAt: '2026-07-05T12:01:30.000Z',
        },
      },
      derivedHints: {
        botAuthoredComment: true,
      },
    });

    await store.appendEventEnvelope(wakeQuestionComment);
    await updater.rebuildFromEvents([wakeQuestionComment]);

    projection = await store.readIssueState('atolis-hq/wake', 20);
    expect(projection?.wake.stage).toBe('blocked');

    const ownerReply = createEventEnvelope({
      eventId: 'evt-comment-owner',
      workItemKey: 'atolis-hq/wake#20',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 20,
        commentId: 'c-owner',
      },
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:01.000Z',
      trigger: 'context-only',
      payload: {
        comment: {
          id: 'c-owner',
          body: 'Go ahead and proceed.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
        },
      },
      derivedHints: {
      },
    });

    await store.appendEventEnvelope(ownerReply);
    await updater.rebuildFromEvents([ownerReply]);

    projection = await store.readIssueState('atolis-hq/wake', 20);
    expect(projection?.wake.stage).toBe('blocked');
    expect(projection?.latestComment?.id).toBe('c-owner');
    expect(projection?.wake.stageHistory).toHaveLength(1);
  });

  it('does not route an implement-stage block when a human replies', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-1',
      workItemKey: 'atolis-hq/wake#21',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 21,
        sourceUrl: 'https://example.test/issues/21',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 21,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/21',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });

    await store.appendEventEnvelope(initialUpsert);
    await updater.rebuildFromEvents([initialUpsert]);

    const runCompleted = createEventEnvelope({
      eventId: 'evt-run-completed',
      workItemKey: 'atolis-hq/wake#21',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.run.completed',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 21,
        runId: 'run-21-1',
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'immediate',
      payload: {
        action: 'implement',
        nextStage: 'blocked',
        runId: 'run-21-1',
      },
    });

    await store.appendEventEnvelope(runCompleted);
    await updater.rebuildFromEvents([runCompleted]);

    let projection = await store.readIssueState('atolis-hq/wake', 21);
    expect(projection?.wake.stage).toBe('blocked');

    const ownerReply = createEventEnvelope({
      eventId: 'evt-comment-owner',
      workItemKey: 'atolis-hq/wake#21',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 21,
        commentId: 'c-owner',
      },
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:01.000Z',
      trigger: 'context-only',
      payload: {
        comment: {
          id: 'c-owner',
          body: 'Go ahead and proceed.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
        },
      },
      derivedHints: {
      },
    });

    await store.appendEventEnvelope(ownerReply);
    await updater.rebuildFromEvents([ownerReply]);

    projection = await store.readIssueState('atolis-hq/wake', 21);
    expect(projection?.wake.stage).toBe('blocked');
    expect(projection?.context.lastRunAction).toBe('implement');
  });

  it('does not unblock a blocked issue on a bot-authored comment', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-1',
      workItemKey: 'atolis-hq/wake#22',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 22,
        sourceUrl: 'https://example.test/issues/22',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 22,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/22',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });

    await store.appendEventEnvelope(initialUpsert);
    await updater.rebuildFromEvents([initialUpsert]);

    const runCompleted = createEventEnvelope({
      eventId: 'evt-run-completed',
      workItemKey: 'atolis-hq/wake#22',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.run.completed',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 22,
        runId: 'run-22-1',
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'immediate',
      payload: {
        action: 'refine',
        nextStage: 'blocked',
        runId: 'run-22-1',
      },
    });

    await store.appendEventEnvelope(runCompleted);
    await updater.rebuildFromEvents([runCompleted]);

    let projection = await store.readIssueState('atolis-hq/wake', 22);
    expect(projection?.wake.stage).toBe('blocked');

    const botComment = createEventEnvelope({
      eventId: 'evt-comment-bot',
      workItemKey: 'atolis-hq/wake#22',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 22,
        commentId: 'c-bot',
      },
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:01.000Z',
      trigger: 'context-only',
      payload: {
        comment: {
          id: 'c-bot',
          body: 'CI failed on this issue.',
          author: { login: 'renovate[bot]' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
        },
      },
      derivedHints: {
        botAuthoredComment: true,
      },
    });

    await store.appendEventEnvelope(botComment);
    await updater.rebuildFromEvents([botComment]);

    projection = await store.readIssueState('atolis-hq/wake', 22);
    expect(projection?.wake.stage).toBe('blocked');
  });

  it('records a human reply on a failed refine issue without changing stage', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-1',
      workItemKey: 'atolis-hq/wake#23',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 23,
        sourceUrl: 'https://example.test/issues/23',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 23,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/23',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });

    await store.appendEventEnvelope(initialUpsert);
    await updater.rebuildFromEvents([initialUpsert]);

    const runCompleted = createEventEnvelope({
      eventId: 'evt-run-completed',
      workItemKey: 'atolis-hq/wake#23',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.run.completed',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 23,
        runId: 'run-23-1',
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'immediate',
      payload: {
        action: 'refine',
        nextStage: 'failed',
        runId: 'run-23-1',
      },
    });

    await store.appendEventEnvelope(runCompleted);
    await updater.rebuildFromEvents([runCompleted]);

    let projection = await store.readIssueState('atolis-hq/wake', 23);
    expect(projection?.wake.stage).toBe('failed');

    const ownerReply = createEventEnvelope({
      eventId: 'evt-comment-owner',
      workItemKey: 'atolis-hq/wake#23',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 23,
        commentId: 'c-owner',
      },
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:01.000Z',
      trigger: 'context-only',
      payload: {
        comment: {
          id: 'c-owner',
          body: 'Retry with this detail.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
        },
      },
      derivedHints: {
      },
    });

    await store.appendEventEnvelope(ownerReply);
    await updater.rebuildFromEvents([ownerReply]);

    projection = await store.readIssueState('atolis-hq/wake', 23);
    expect(projection?.wake.stage).toBe('failed');
    expect(projection?.latestComment?.id).toBe('c-owner');
    expect(projection?.wake.stageHistory).toHaveLength(1);
  });

  it('records a human reply on a failed implement issue without changing stage', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const initialUpsert = createEventEnvelope({
      eventId: 'evt-issue-1',
      workItemKey: 'atolis-hq/wake#24',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 24,
        sourceUrl: 'https://example.test/issues/24',
      },
      occurredAt: '2026-07-05T12:00:00.000Z',
      ingestedAt: '2026-07-05T12:00:01.000Z',
      trigger: 'immediate',
      payload: {
        ticket: {
          repo: 'atolis-hq/wake',
          number: 24,
          title: 'Example',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/24',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
      },
    });

    await store.appendEventEnvelope(initialUpsert);
    await updater.rebuildFromEvents([initialUpsert]);

    const runCompleted = createEventEnvelope({
      eventId: 'evt-run-completed',
      workItemKey: 'atolis-hq/wake#24',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.run.completed',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 24,
        runId: 'run-24-1',
      },
      occurredAt: '2026-07-05T12:01:00.000Z',
      ingestedAt: '2026-07-05T12:01:00.000Z',
      trigger: 'immediate',
      payload: {
        action: 'implement',
        nextStage: 'failed',
        runId: 'run-24-1',
      },
    });

    await store.appendEventEnvelope(runCompleted);
    await updater.rebuildFromEvents([runCompleted]);

    let projection = await store.readIssueState('atolis-hq/wake', 24);
    expect(projection?.wake.stage).toBe('failed');

    const ownerReply = createEventEnvelope({
      eventId: 'evt-comment-owner',
      workItemKey: 'atolis-hq/wake#24',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 24,
        commentId: 'c-owner',
      },
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:01.000Z',
      trigger: 'context-only',
      payload: {
        comment: {
          id: 'c-owner',
          body: 'I fixed the prerequisite, please continue.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
        },
      },
      derivedHints: {
      },
    });

    await store.appendEventEnvelope(ownerReply);
    await updater.rebuildFromEvents([ownerReply]);

    projection = await store.readIssueState('atolis-hq/wake', 24);
    expect(projection?.wake.stage).toBe('failed');
    expect(projection?.context.lastRunAction).toBe('implement');
  });
});
