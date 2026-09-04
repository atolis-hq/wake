import { describe, expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import {
  ExecutionEventType,
  executionProjection,
  runId,
  runStream,
  runsByWorkflowInstanceProjection,
} from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';

describe('execution projections', () => {
  it('registers a preparing run immediately, without duplicating it when it starts', () => {
    const run = runId('projection-preparing-run');
    const workflow = workflowInstanceId('workflow-projection-preparing');
    const preparation = eventEnvelope(
      ExecutionEventType.RunPreparationStarted,
      {
        activationId: activationId('activation-projection-preparing'),
        activity: activityName('implement'),
        workflowInstanceId: workflow,
        orchestrationGroupId: orchestrationGroupId('group-projection-preparing'),
        attempt: 1,
        startedAt: '2026-08-30T12:00:00.000Z',
      },
      runStream(run),
      1,
    );
    const started = eventEnvelope(
      ExecutionEventType.RunStarted,
      { ...preparation.event.payload, startedAt: '2026-08-30T12:01:00.000Z' },
      runStream(run),
      2,
    );

    const preparingMembership = runsByWorkflowInstanceProjection.project(
      runsByWorkflowInstanceProjection.initial(workflow),
      preparation,
    );
    const membership = runsByWorkflowInstanceProjection.project(preparingMembership, started);
    const preparingView = executionProjection.project(
      executionProjection.initial(run),
      preparation,
    );

    expect(preparingMembership).toEqual([run]);
    expect(membership).toEqual([run]);
    expect(preparingView.view).toMatchObject({ runId: run, status: 'starting' });
  });

  it('registers a historical RunStarted-first run once', () => {
    const run = runId('projection-historical-start');
    const workflow = workflowInstanceId('workflow-projection-historical');
    const started = eventEnvelope(
      ExecutionEventType.RunStarted,
      {
        activationId: activationId('activation-projection-historical'),
        activity: activityName('implement'),
        workflowInstanceId: workflow,
        orchestrationGroupId: orchestrationGroupId('group-projection-historical'),
        attempt: 1,
        startedAt: '2026-08-30T12:00:00.000Z',
      },
      runStream(run),
      1,
    );

    const membership = runsByWorkflowInstanceProjection.project(
      runsByWorkflowInstanceProjection.initial(workflow),
      started,
    );

    expect(membership).toEqual([run]);
  });
});
