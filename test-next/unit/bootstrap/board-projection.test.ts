import { describe, expect, it } from 'vitest';
import { OrchestrationEventType, workflowInstanceId, workflowInstanceStream } from '../../../src-next/orchestration/index.js';
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
});
