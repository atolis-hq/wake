import { expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import { ExecutionEventType, foldRun, runId, runStream } from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';

it('keeps transport status separate from the Activity outcome', () => {
  expect(foldRun([])).toBeNull();
});

it('projects the originating stage from the run start event', () => {
  const started = eventEnvelope(
    ExecutionEventType.RunStarted,
    {
      activationId: activationId('activation-1'),
      activity: activityName('implement'),
      stage: 'refine',
      workflowInstanceId: workflowInstanceId('workflow-1'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
      attempt: 1,
      startedAt: '2026-07-31T12:00:00.000Z',
    },
    runStream(runId('run-1')),
  );

  expect(foldRun([started])).toMatchObject({ stage: 'refine' });
});
