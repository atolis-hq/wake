import { describe, expect, it } from 'vitest';
import { activationId } from '../../../src/activities/index.js';
import {
  boardProjection,
  type BoardProjectionView,
} from '../../../src/bootstrap/board-projection.js';
import {
  ExecutionEventType,
  ExecutionFailureCode,
  runId,
  runStream,
} from '../../../src/execution/index.js';
import {
  OrchestrationEventType,
  orchestrationGroupId,
  workflowInstanceId,
  workflowInstanceStream,
  workflowName,
} from '../../../src/orchestration/index.js';
import { WorkEventType, workItemStream } from '../../../src/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

const parent = workId('queue-parent');
const first = workId('queue-first');
const second = workId('queue-second');
const parentWorkflow = workflowInstanceId(`primary:${parent}`);
const parentStream = workflowInstanceStream(parentWorkflow);
const secondWorkflow = workflowInstanceId(`delegated:${second}`);

let position = 0;
const next = () => ++position;

function child(id: ReturnType<typeof workId>, assignmentId: string, prerequisiteOn?: string) {
  return {
    assignmentId,
    objective: `Do ${assignmentId}`,
    criteria: ['Done'],
    workflowName: workflowName('child'),
    workflowFingerprint: 'fingerprint-1',
    context: [],
    outputs: [{ name: 'change', path: 'change.md' }],
    workItemId: id,
    workflowInstanceId: workflowInstanceId(`delegated:${id}`),
    grantId: `grant-${id}`,
    ...(prerequisiteOn === undefined
      ? {}
      : {
          prerequisites: [
            { assignmentId: prerequisiteOn, output: 'change', condition: 'delivery-ready' },
          ],
        }),
  };
}

function project(
  view: BoardProjectionView,
  ...events: readonly ReturnType<typeof eventEnvelope>[]
) {
  return events.reduce((state, event) => boardProjection.project(state, event), view);
}

const created = (id: ReturnType<typeof workId>, parentId?: ReturnType<typeof workId>) =>
  eventEnvelope(
    WorkEventType.ItemCreated,
    {
      objective: `Item ${id}`,
      ...(parentId === undefined
        ? {}
        : {
            delegation: {
              parentWorkItemId: parentId,
              rootWorkItemId: parentId,
              ancestors: [parentId],
            },
          }),
    },
    workItemStream(id),
    next(),
  );

const started = (id: ReturnType<typeof workId>, instance = workflowInstanceId(`delegated:${id}`)) =>
  eventEnvelope(
    OrchestrationEventType.InstanceStarted,
    {
      workItemId: id,
      workflowName: workflowName('child'),
      orchestrationGroupId: orchestrationGroupId(`delegated:${id}`),
      entry: 'implement',
    },
    workflowInstanceStream(instance),
    next(),
  );

const reserved = () =>
  eventEnvelope(
    OrchestrationEventType.DelegationReserved,
    {
      cohortId: 'cohort-1',
      parentWorkflowInstanceId: parentWorkflow,
      parentWorkItemId: parent,
      rootWorkItemId: parent,
      activationId: activationId(`${parentWorkflow}:delegate:1`),
      runId: runId('run-queue'),
      ancestors: [parent],
      maxDepth: 1,
      maxDescendants: 8,
      children: [child(first, 'one'), child(second, 'two', 'one')],
    },
    parentStream,
    next(),
  );

const prerequisiteBlocked = () =>
  eventEnvelope(
    OrchestrationEventType.DelegationPrerequisiteBlocked,
    { childWorkItemId: second, reason: 'Prerequisite inputs have not been pinned' },
    parentStream,
    next(),
  );

function queued(): BoardProjectionView {
  position = 0;
  return project(
    boardProjection.initial('global'),
    created(parent),
    started(parent, parentWorkflow),
    created(first, parent),
    created(second, parent),
    reserved(),
  );
}

describe('operator board: queued delegated children', () => {
  it('shows a reserved child as queued with its declared prerequisites', () => {
    const card = queued().cards[second]!;
    expect(card.condition).toBe('ready');
    expect(card.prerequisiteWait).toEqual({
      prerequisites: [{ assignmentId: 'one', output: 'change', condition: 'delivery-ready' }],
    });
    expect(queued().cards[first]!.prerequisiteWait).toEqual({ prerequisites: [] });
  });

  it('retains reservation metadata when children are created afterwards', () => {
    const view = project(
      boardProjection.initial('global'),
      created(parent),
      started(parent, parentWorkflow),
      reserved(),
      created(first, parent),
      created(second, parent),
      prerequisiteBlocked(),
    );
    expect(view.cards[second]!.prerequisiteWait).toEqual({
      reason: 'Prerequisite inputs have not been pinned',
      prerequisites: [{ assignmentId: 'one', output: 'change', condition: 'delivery-ready' }],
    });
  });

  it('records the journal reason when prerequisites are not pinned', () => {
    const card = project(queued(), prerequisiteBlocked()).cards[second]!;
    expect(card.prerequisiteWait?.reason).toBe('Prerequisite inputs have not been pinned');
    expect(card.condition).toBe('ready');
  });

  it('clears a queued marker when a replacement drops the child', () => {
    const view = queued();
    const reservation = reserved();
    const updated = project(
      view,
      eventEnvelope(
        OrchestrationEventType.DelegationReserved,
        {
          ...reservation.event.payload,
          children: [
            {
              ...child(workId('queue-replacement'), 'one-repair'),
              replaces: { cohortId: 'cohort-1', assignmentId: 'one' },
            },
          ],
        },
        parentStream,
        next(),
      ),
    );
    expect(updated.cards[first]!.prerequisiteWait).toBeUndefined();
  });

  it('purges a deleted queued card and ignores blocks without a card', () => {
    const view = project(
      queued(),
      eventEnvelope(WorkEventType.ItemDeleted, {}, workItemStream(second), next()),
      prerequisiteBlocked(),
    );
    expect(view.cards[second]).toBeUndefined();
  });

  it('clears the wait when the child workflow starts', () => {
    const view = project(queued(), prerequisiteBlocked(), started(second));
    expect(view.cards[second]!.prerequisiteWait).toBeUndefined();
  });

  it.each([OrchestrationEventType.DelegationFailed, OrchestrationEventType.DelegationJoined])(
    'clears the wait when the cohort settles via %s',
    (eventType) => {
      const view = project(
        queued(),
        eventEnvelope(
          OrchestrationEventType.DelegationWaitStarted,
          { cohortId: 'cohort-1', activationId: activationId(`${parentWorkflow}:delegate:1`) },
          parentStream,
          next(),
        ),
        eventEnvelope(
          eventType,
          eventType === OrchestrationEventType.DelegationFailed
            ? { cohortId: 'cohort-1', reason: 'failed' }
            : {
                cohortId: 'cohort-1',
                results: [{ cohortId: 'cohort-1', childWorkItemId: first, outputs: [] }],
              },
          parentStream,
          next(),
        ),
      );
      expect(view.cards[second]!.prerequisiteWait).toBeUndefined();
    },
  );

  it.each([WorkEventType.ItemClosed, WorkEventType.ItemCancelled])(
    'clears the wait on %s',
    (eventType) => {
      const view = project(
        queued(),
        eventEnvelope(eventType, { reason: 'x' }, workItemStream(second), next()),
      );
      expect(view.cards[second]!.prerequisiteWait).toBeUndefined();
      expect(view.cards[second]!.condition).toBe('finished');
    },
  );
});

describe('operator board: superseded workflow instances', () => {
  it('clears a superseded marker when a new primary workflow starts', () => {
    const view = project(
      queued(),
      started(second),
      eventEnvelope(
        OrchestrationEventType.InstanceSuperseded,
        {},
        workflowInstanceStream(secondWorkflow),
        next(),
      ),
      started(second),
    );
    expect(view.cards[second]!.superseded).toBeUndefined();
    expect(view.cards[second]!.condition).toBe('ready');
  });

  it('moves a superseded child to Finished flagged superseded, not Error', () => {
    const view = project(
      queued(),
      started(second),
      eventEnvelope(
        OrchestrationEventType.InstanceSuperseded,
        {},
        workflowInstanceStream(secondWorkflow),
        next(),
      ),
    );
    expect(view.cards[second]!.condition).toBe('finished');
    expect(view.cards[second]!.superseded).toBe(true);
  });

  it('keeps a failed run in Error', () => {
    const run = runId('run-failed');
    const view = project(
      queued(),
      started(second),
      eventEnvelope(
        ExecutionEventType.RunStarted,
        {
          activationId: activationId(`${secondWorkflow}:implement:1`),
          activity: 'agent',
          stage: 'implement',
          workflowInstanceId: secondWorkflow,
          orchestrationGroupId: orchestrationGroupId(`delegated:${second}`),
          attempt: 1,
          startedAt: '2026-08-30T12:00:00.000Z',
        },
        runStream(run),
        next(),
      ),
      eventEnvelope(
        ExecutionEventType.RunFailed,
        {
          failure: { kind: ExecutionFailureCode.Unexpected, message: 'runner exited' },
          finishedAt: '2026-08-30T12:01:00.000Z',
        },
        runStream(run),
        next(),
      ),
    );
    expect(view.cards[second]!.condition).toBe('error');
    expect(view.cards[second]!.superseded).toBeUndefined();
  });
});
