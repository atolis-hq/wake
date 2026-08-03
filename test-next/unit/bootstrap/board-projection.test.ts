import { describe, expect, it } from 'vitest';
import { activationId, activityName } from '../../../src-next/activities/index.js';
import { ExecutionEventType, runId, runStream } from '../../../src-next/execution/index.js';
import { OrchestrationEventType, orchestrationGroupId, workflowInstanceId, workflowInstanceStream } from '../../../src-next/orchestration/index.js';
import { toWorkItemKey } from '../../../src-next/surfaces/api/contracts/index.js';
import { WorkEventType, workItemStream } from '../../../src-next/work/index.js';
import { boardProjection } from '../../../src-next/bootstrap/board-projection.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

describe('operator board projection', () => {
  it('places an approval signal wait in Needs human with the canonical work-item key', () => {
    const workItemId = workId('board-approval');
    const workflowId = workflowInstanceId(`primary:${workItemId}`);
    const events = [
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Await approval' }, workItemStream(workItemId), 1),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        { workItemId, workflowName: 'approval', orchestrationGroupId: `primary:${workItemId}`, entry: 'refine' },
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
      condition: 'needs-human',
      awaitingApproval: true,
    });
  });

  it('shows an active run, accumulates token/cost totals, and clears the run on completion', () => {
    const item = workId('board-run');
    const workflowId = workflowInstanceId(`primary:${item}`);
    const run = runId('run-1');
    const started = [
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Ship it' }, workItemStream(item), 1),
      eventEnvelope(
        OrchestrationEventType.InstanceStarted,
        { workItemId: item, workflowName: 'delivery', orchestrationGroupId: orchestrationGroupId(`primary:${item}`), entry: 'implement' },
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
    ].reduce((view, event) => boardProjection.project(view, event), boardProjection.initial('global'));

    expect(started.cards[item]).toMatchObject({
      condition: 'active',
      runCount: 1,
      activeRun: { action: 'implement', runnerName: 'claude', startedAt: '2026-08-03T12:00:00.000Z' },
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
    expect(finished.cards[item]).toMatchObject({ totalTokens: 35, totalCostUsd: 0.03 });
  });
});
