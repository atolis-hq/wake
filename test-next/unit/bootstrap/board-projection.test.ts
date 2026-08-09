import { describe, expect, it } from 'vitest';
import { activationId, activityName } from '../../../src-next/activities/index.js';
import { boardProjection } from '../../../src-next/bootstrap/board-projection.js';
import { ExecutionEventType, runId, runStream } from '../../../src-next/execution/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  workflowInstanceId,
  workflowInstanceStream,
} from '../../../src-next/orchestration/index.js';
import { toWorkItemKey } from '../../../src-next/surfaces/api/contracts/index.js';
import { WorkEventType, workItemStream } from '../../../src-next/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

describe('operator board projection', () => {
  it('places an approval signal wait in Needs Input with the canonical work-item key', () => {
    const workItemId = workId('board-approval');
    const workflowId = workflowInstanceId(`primary:${workItemId}`);
    const events = [
      eventEnvelope(
        WorkEventType.ItemCreated,
        { objective: 'Await approval' },
        workItemStream(workItemId),
        1,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'approval',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        OrchestrationEventType.SignalWaitStarted,
        { signalKind: 'approved', from: [{ kind: 'human' }] },
        workflowInstanceStream(workflowId),
        3,
      ),
    ];

    const view = events.reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );

    expect(view.cards[workItemId]).toMatchObject({
      workItemKey: toWorkItemKey(workItemId),
      condition: 'needs-input',
      awaitingApproval: true,
    });
  });

  it('stays Ready once the activity is requested, moving to Active only once its Run starts', () => {
    const item = workId('board-activity-requested');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const events = [
      eventEnvelope(
        WorkEventType.ItemCreated,
        { objective: 'Dispatch soon' },
        workItemStream(item),
        1,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: item,
          workflowName: 'dark-factory',
          orchestrationGroupId: `primary:${item}`,
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        OrchestrationEventType.StageEntered,
        { stage: 'refine' },
        workflowInstanceStream(workflowId),
        3,
      ),
      eventEnvelope(
        OrchestrationEventType.ActivityRequested,
        {
          activationId: activationId('activation-1'),
          ordinal: 1,
          activity: activityName('agent'),
          input: {},
        },
        workflowInstanceStream(workflowId),
        4,
      ),
    ];

    const view = events.reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );

    expect(view.cards[item]).toMatchObject({ condition: 'ready', stage: 'refine' });

    const withRun = boardProjection.project(
      view,
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-1'),
          activity: activityName('agent'),
          workflowInstanceId: workflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          attempt: 1,
          startedAt: '2026-08-09T12:00:00.000Z',
        },
        runStream(runId('run-activity-requested-1')),
        5,
      ),
    );

    expect(withRun.cards[item]).toMatchObject({ condition: 'active', stage: 'refine' });
  });

  it("does not let a watch child's own instance start reset the shared card out of Needs Input", () => {
    const workItemId = workId('board-watch-gate');
    const workflowId = workflowInstanceId(`primary:${workItemId}`);
    const childWorkflowId = workflowInstanceId(`primary:${workItemId}:watch:review:trigger:run-1`);
    const events = [
      eventEnvelope(
        WorkEventType.ItemCreated,
        { objective: 'Gate on a watch review' },
        workItemStream(workItemId),
        1,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'dark-factory',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        OrchestrationEventType.SignalWaitStarted,
        {
          signalKind: 'orchestration.watch-gate-verdict',
          from: [{ kind: 'watch', watch: 'review' }],
        },
        workflowInstanceStream(workflowId),
        3,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'review',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'review',
          parentWorkflowInstanceId: workflowId,
          watchId: 'review',
          triggerId: 'run-1',
          causalCycleId: 'cycle-1',
          requestId: 'request-1',
          childWorkflowInstanceId: childWorkflowId,
        },
        workflowInstanceStream(childWorkflowId),
        4,
      ),
    ];

    const view = events.reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );

    expect(view.cards[workItemId]).toMatchObject({
      condition: 'needs-input',
      stage: 'refine',
      workflowName: 'dark-factory',
    });
  });

  it("keeps a card in Needs Input, with awaitingApproval intact, while its watch child's own run is in flight and after it finishes", () => {
    const workItemId = workId('board-watch-run-needs-input');
    const workflowId = workflowInstanceId(`primary:${workItemId}`);
    const childWorkflowId = workflowInstanceId(`primary:${workItemId}:watch:review:trigger:run-1`);
    const run = runId('run-watch-child-1');
    const withChildStarted = [
      eventEnvelope(
        WorkEventType.ItemCreated,
        { objective: 'Gate on a watch review' },
        workItemStream(workItemId),
        1,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'dark-factory',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        OrchestrationEventType.SignalWaitStarted,
        {
          signalKind: 'orchestration.watch-gate-verdict',
          from: [{ kind: 'watch', watch: 'review' }],
        },
        workflowInstanceStream(workflowId),
        3,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'review',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'review',
          parentWorkflowInstanceId: workflowId,
          watchId: 'review',
          triggerId: 'run-1',
          causalCycleId: 'cycle-1',
          requestId: 'request-1',
          childWorkflowInstanceId: childWorkflowId,
        },
        workflowInstanceStream(childWorkflowId),
        4,
      ),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-watch-1'),
          activity: activityName('agent'),
          workflowInstanceId: childWorkflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${workItemId}`),
          attempt: 1,
          startedAt: '2026-08-09T12:00:00.000Z',
        },
        runStream(run),
        5,
      ),
    ].reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );

    expect(withChildStarted.cards[workItemId]).toMatchObject({
      condition: 'needs-input',
      awaitingApproval: true,
      activeRun: { action: 'review' },
    });

    const finished = boardProjection.project(
      withChildStarted,
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        { outcome: { kind: 'done' }, finishedAt: '2026-08-09T12:01:00.000Z' },
        runStream(run),
        6,
      ),
    );

    expect(finished.cards[workItemId]).toMatchObject({
      condition: 'needs-input',
      awaitingApproval: true,
      lastRunOutcome: 'done',
    });
    expect(finished.cards[workItemId]!.activeRun).toBeUndefined();
  });

  it("labels an active run with the watch child's own action, not the parent's current stage", () => {
    const workItemId = workId('board-child-run-label');
    const workflowId = workflowInstanceId(`primary:${workItemId}`);
    const childWorkflowId = workflowInstanceId(`primary:${workItemId}:watch:review:trigger:run-1`);
    const run = runId('run-child-1');
    const events = [
      eventEnvelope(
        WorkEventType.ItemCreated,
        { objective: 'Gate on a watch review' },
        workItemStream(workItemId),
        1,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'dark-factory',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'implement',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'review',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'review',
          parentWorkflowInstanceId: workflowId,
          watchId: 'review',
          triggerId: 'run-1',
          causalCycleId: 'cycle-1',
          requestId: 'request-1',
          childWorkflowInstanceId: childWorkflowId,
        },
        workflowInstanceStream(childWorkflowId),
        3,
      ),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-child-1'),
          activity: activityName('agent'),
          workflowInstanceId: childWorkflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${workItemId}`),
          attempt: 1,
          startedAt: '2026-08-09T12:00:00.000Z',
        },
        runStream(run),
        4,
      ),
    ];

    const view = events.reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );

    expect(view.cards[workItemId]).toMatchObject({
      stage: 'implement',
      activeRun: { action: 'review' },
    });
  });

  it('folds a workflow event against a checkpoint persisted before the children field existed', () => {
    const workItemId = workId('board-legacy-checkpoint');
    const workflowId = workflowInstanceId(`primary:${workItemId}`);
    const seeded = [
      eventEnvelope(
        WorkEventType.ItemCreated,
        { objective: 'Pre-dates the children field' },
        workItemStream(workItemId),
        1,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId,
          workflowName: 'dark-factory',
          orchestrationGroupId: `primary:${workItemId}`,
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
    ].reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );
    // A checkpoint written before the `children` field was added round-trips
    // through storage without it, the same as ProjectionRunner resuming from
    // a persisted value rather than calling initial() again.
    const { children: _children, ...legacyView } = seeded;

    const next = boardProjection.project(
      legacyView as typeof seeded,
      eventEnvelope(
        OrchestrationEventType.StageEntered,
        { stage: 'implement' },
        workflowInstanceStream(workflowId),
        3,
      ),
    );

    expect(next.cards[workItemId]).toMatchObject({ stage: 'implement' });
  });

  it('folds a run-terminal event against a checkpoint persisted before the childRuns field existed', () => {
    const item = workId('board-legacy-childruns');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const run = runId('run-legacy-1');
    const seeded = [
      eventEnvelope(
        WorkEventType.ItemCreated,
        { objective: 'Pre-dates the childRuns field' },
        workItemStream(item),
        1,
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: item,
          workflowName: 'dark-factory',
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-legacy-1'),
          activity: activityName('refine'),
          workflowInstanceId: workflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          attempt: 1,
          startedAt: '2026-08-09T13:40:37.355Z',
          runner: { name: 'fake-worker' },
        },
        runStream(run),
        3,
      ),
    ].reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );
    // A checkpoint written before `childRuns` was added (same as the
    // `children` case above) round-trips through storage without it.
    const { childRuns: _childRuns, ...legacyView } = seeded;

    const next = boardProjection.project(
      legacyView as typeof seeded,
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        { outcome: { kind: 'done' }, finishedAt: '2026-08-09T13:40:59.015Z' },
        runStream(run),
        4,
      ),
    );

    expect(next.cards[item]).toMatchObject({ condition: 'ready' });
    expect(next.cards[item]!.activeRun).toBeUndefined();
  });

  it('shows an active run, accumulates token/cost totals, and clears the run on completion', () => {
    const item = workId('board-run');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const run = runId('run-1');
    const started = [
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Ship it' }, workItemStream(item), 1),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: item,
          workflowName: 'delivery',
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          entry: 'implement',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-1'),
          activity: activityName('implement'),
          workflowInstanceId: workflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          attempt: 1,
          startedAt: '2026-08-03T12:00:00.000Z',
          runner: { name: 'claude' },
        },
        runStream(run),
        3,
      ),
    ].reduce(
      (view, event) => boardProjection.project(view, event),
      boardProjection.initial('global'),
    );

    expect(started.cards[item]).toMatchObject({
      condition: 'active',
      runCount: 1,
      activeRun: {
        action: 'implement',
        runnerName: 'claude',
        startedAt: '2026-08-03T12:00:00.000Z',
      },
    });

    const withResult = boardProjection.project(
      started,
      eventEnvelope(
        ExecutionEventType.RunRunnerResultReported,
        {
          transport: 'succeeded',
          agent: {
            outcome: 'DONE',
            displayBody: 'Done.',
            metadata: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.03 },
          },
        },
        runStream(run),
        4,
      ),
    );
    expect(withResult.cards[item]).toMatchObject({ totalTokens: 35, totalCostUsd: 0.03 });
    expect(withResult.cards[item]!.activeRun).toBeDefined();

    const finished = boardProjection.project(
      withResult,
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        { outcome: { kind: 'done' }, finishedAt: '2026-08-03T12:05:00.000Z' },
        runStream(run),
        5,
      ),
    );
    expect(finished.cards[item]!.activeRun).toBeUndefined();
    expect(finished.cards[item]).toMatchObject({
      totalTokens: 35,
      totalCostUsd: 0.03,
      totalDurationMs: 300_000,
    });
  });

  it('returns a successfully finished run to Ready rather than leaving the card Active', () => {
    const item = workId('board-run-ready');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const run = runId('run-ready-1');
    const started = [
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Ship it' }, workItemStream(item), 1),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: item,
          workflowName: 'delivery',
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-ready-1'),
          activity: activityName('refine'),
          workflowInstanceId: workflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          attempt: 1,
          startedAt: '2026-08-03T12:00:00.000Z',
        },
        runStream(run),
        3,
      ),
    ].reduce(
      (view, event) => boardProjection.project(view, event),
      boardProjection.initial('global'),
    );

    const finished = boardProjection.project(
      started,
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        { outcome: { kind: 'done' }, finishedAt: '2026-08-03T12:05:00.000Z' },
        runStream(run),
        4,
      ),
    );

    expect(finished.cards[item]).toMatchObject({ condition: 'ready' });
  });

  it('moves a card to error and clears the active run when the agent reports a failed outcome', () => {
    const item = workId('board-run-failed');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const run = runId('run-failed-1');
    const started = [
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Ship it' }, workItemStream(item), 1),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: item,
          workflowName: 'delivery',
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-1'),
          activity: activityName('refine'),
          workflowInstanceId: workflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          attempt: 1,
          startedAt: '2026-08-03T12:00:00.000Z',
        },
        runStream(run),
        3,
      ),
    ].reduce(
      (view, event) => boardProjection.project(view, event),
      boardProjection.initial('global'),
    );

    const failed = boardProjection.project(
      started,
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        { outcome: { kind: 'failed' }, finishedAt: '2026-08-03T12:05:00.000Z' },
        runStream(run),
        4,
      ),
    );

    expect(failed.cards[item]).toMatchObject({
      condition: 'error',
      lastRunOutcome: 'failed',
      totalDurationMs: 300_000,
    });
    expect(failed.cards[item]!.activeRun).toBeUndefined();
  });

  it('resets a card to Ready on entering a new stage regardless of the condition it inherits', () => {
    const item = workId('board-stage-reset');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const run = runId('run-stage-reset-1');
    const failed = [
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Ship it' }, workItemStream(item), 1),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: item,
          workflowName: 'dark-factory',
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId('activation-stage-reset-1'),
          activity: activityName('refine'),
          workflowInstanceId: workflowId,
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          attempt: 1,
          startedAt: '2026-08-03T12:00:00.000Z',
        },
        runStream(run),
        3,
      ),
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        { outcome: { kind: 'failed' }, finishedAt: '2026-08-03T12:05:00.000Z' },
        runStream(run),
        4,
      ),
    ].reduce(
      (view, event) => boardProjection.project(view, event),
      boardProjection.initial('global'),
    );
    expect(failed.cards[item]).toMatchObject({ condition: 'error' });

    const nextStage = boardProjection.project(
      failed,
      eventEnvelope(
        OrchestrationEventType.StageEntered,
        { stage: 'refine' },
        workflowInstanceStream(workflowId),
        5,
      ),
    );

    expect(nextStage.cards[item]).toMatchObject({ condition: 'ready', stage: 'refine' });
  });

  it('keeps a closed item in Finished even when its orphaned workflow instance is blocked afterward', () => {
    const item = workId('board-closed-then-blocked');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const view = [
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Ship it' }, workItemStream(item), 1),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: item,
          workflowName: 'dark-factory',
          orchestrationGroupId: orchestrationGroupId(`primary:${item}`),
          entry: 'refine',
        },
        workflowInstanceStream(workflowId),
        2,
      ),
      // There is no reopen command (work-item.spec.md) — closed/cancelled is
      // terminal — but the workflow instance can still emit a status event of
      // its own (e.g. InstanceBlocked, halting the now-orphaned instance)
      // after the item closes.
      eventEnvelope(WorkEventType.ItemClosed, { reason: 'done' }, workItemStream(item), 3),
      eventEnvelope(
        OrchestrationEventType.InstanceBlocked,
        { reason: 'work item closed' },
        workflowInstanceStream(workflowId),
        4,
      ),
    ].reduce(
      (current, event) => boardProjection.project(current, event),
      boardProjection.initial('global'),
    );

    expect(view.cards[item]).toMatchObject({ condition: 'finished' });
  });
});
