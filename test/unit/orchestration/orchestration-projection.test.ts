import { expect, it } from 'vitest';
import {
  foldWorkflowInstance,
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

it('continues a legacy event-history projection and replaces it with the canonical view', () => {
  const stream = workflowInstanceStream(workflowInstanceId('workflow-projection-legacy'));
  const started = eventEnvelope(
    OrchestrationEventType.InstanceStarted,
    {
      workItemId: workId('projection-legacy'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-projection-legacy'),
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
  const legacy = {
    events: [
      {
        ...started.event,
        stream: started.stream,
        recordedAt: started.recordedAt,
        sequence: 1,
        globalPosition: 1,
      },
    ],
    view: foldWorkflowInstance([started]),
  };

  const projected = orchestrationProjection.project(
    legacy as unknown as ReturnType<typeof orchestrationProjection.initial>,
    stageEntered,
  );

  expect(projected).toMatchObject({
    workflowInstanceId: stream.id,
    currentStage: stageName('review'),
  });
  expect(projected).not.toHaveProperty('events');
});
