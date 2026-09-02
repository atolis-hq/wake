import { expect, it } from 'vitest';
import * as orchestration from '../../../src/orchestration/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  orchestrationProjection,
  stageName,
  workflowInstanceId,
  workflowInstanceStream,
  workflowName,
} from '../../../src/orchestration/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

it('continues a canonical workflow view', () => {
  const stream = workflowInstanceStream(workflowInstanceId('workflow-projection-canonical'));
  const started = eventEnvelope(
    OrchestrationEventType.InstanceStarted,
    {
      workItemId: workId('projection-canonical'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-projection-canonical'),
      entry: stageName('implement'),
    },
    stream,
    1,
  );
  const stageEntered = eventEnvelope(
    OrchestrationEventType.StageEntered,
    { stage: stageName('review') },
    stream,
    2,
  );
  const initial = orchestrationProjection.project(
    orchestrationProjection.initial(stream.id),
    started,
  );

  const projected = orchestrationProjection.project(initial, stageEntered);

  expect(projected).toMatchObject({
    workflowInstanceId: stream.id,
    currentStage: stageName('review'),
  });
  expect(projected).not.toHaveProperty('events');
});

it('does not expose a legacy projection compatibility accessor', () => {
  expect(orchestration).not.toHaveProperty('workflowInstanceProjectionView');
});
