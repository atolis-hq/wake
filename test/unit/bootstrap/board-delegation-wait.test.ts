import { describe, expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import {
  boardDelegationWait,
  boardProjection,
  type BoardProjectionView,
} from '../../../src/bootstrap/board-projection.js';
import { ExecutionEventType, runId, runStream } from '../../../src/execution/index.js';
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

const parent = workId('delegating-parent');
const parentWorkflow = workflowInstanceId(`primary:${parent}`);
const parentStream = workflowInstanceStream(parentWorkflow);
const delegatingActivation = activationId(`${parentWorkflow}:delegate:1`);
const delegatingRun = runId('run-delegate');
const childIds = [workId('child-a'), workId('child-b'), workId('child-c')];

let position = 0;
const next = () => ++position;

function child(id: ReturnType<typeof workId>, assignmentId: string, replaces?: string) {
  return {
    assignmentId,
    objective: `Do ${assignmentId}`,
    criteria: ['Done'],
    workflowName: workflowName('child'),
    workflowFingerprint: 'fingerprint-1',
    context: [],
    outputs: [{ name: 'findings', path: 'findings.md' }],
    workItemId: id,
    workflowInstanceId: workflowInstanceId(`delegated:${id}`),
    grantId: `grant-${id}`,
    ...(replaces === undefined
      ? {}
      : { replaces: { cohortId: 'cohort-1', assignmentId: replaces } }),
  };
}

function reserved(children: readonly ReturnType<typeof child>[]) {
  return eventEnvelope(
    OrchestrationEventType.DelegationReserved,
    {
      cohortId: 'cohort-1',
      parentWorkflowInstanceId: parentWorkflow,
      parentWorkItemId: parent,
      rootWorkItemId: parent,
      activationId: delegatingActivation,
      runId: delegatingRun,
      ancestors: [parent],
      maxDepth: 1,
      maxDescendants: 8,
      children,
    },
    parentStream,
    next(),
  );
}

const waitStarted = () =>
  eventEnvelope(
    OrchestrationEventType.DelegationWaitStarted,
    { cohortId: 'cohort-1', activationId: delegatingActivation },
    parentStream,
    next(),
  );

const resultSelected = (id: ReturnType<typeof workId>) =>
  eventEnvelope(
    OrchestrationEventType.DelegationResultSelected,
    {
      cohortId: 'cohort-1',
      childWorkItemId: id,
      outputs: [{ name: 'findings', reference: { workItemId: id, revisionId: 'revision-1' } }],
    },
    parentStream,
    next(),
  );

const blockedRunSucceeded = () =>
  eventEnvelope(
    ExecutionEventType.RunSucceeded,
    {
      outcome: { kind: 'blocked', data: { status: 'BLOCKED' } },
      finishedAt: '2026-08-30T12:05:00.000Z',
    },
    runStream(delegatingRun),
    next(),
  );

function project(
  view: BoardProjectionView,
  ...events: readonly ReturnType<typeof eventEnvelope>[]
) {
  return events.reduce((state, event) => boardProjection.project(state, event), view);
}

/** The parent has started its delegating run and reserved a three-child cohort. */
function delegatingParent(): BoardProjectionView {
  position = 0;
  return project(
    boardProjection.initial('global'),
    eventEnvelope(
      WorkEventType.ItemCreated,
      { objective: 'Parent' },
      workItemStream(parent),
      next(),
    ),
    eventEnvelope(
      OrchestrationEventType.InstanceStarted,
      {
        workItemId: parent,
        workflowName: workflowName('dark-factory'),
        orchestrationGroupId: orchestrationGroupId(`primary:${parent}`),
        entry: 'delegate',
      },
      parentStream,
      next(),
    ),
    eventEnvelope(
      ExecutionEventType.RunStarted,
      {
        activationId: delegatingActivation,
        activity: activityName('agent'),
        stage: 'delegate',
        workflowInstanceId: parentWorkflow,
        orchestrationGroupId: orchestrationGroupId(`primary:${parent}`),
        attempt: 1,
        startedAt: '2026-08-30T12:00:00.000Z',
      },
      runStream(delegatingRun),
      next(),
    ),
    reserved(childIds.map((id, index) => child(id, `task-${index}`))),
  );
}

describe('operator board: parent waiting on a delegated cohort', () => {
  it('reads as Active with child progress, not Needs input, after a held BLOCKED delegating run', () => {
    const view = project(delegatingParent(), waitStarted(), blockedRunSucceeded());
    const card = view.cards[parent]!;

    expect(card.condition).toBe('active');
    expect(card.lastRunOutcome).toBe('blocked');
    expect(boardDelegationWait(card)).toEqual({ total: 3, finished: 0, needsAttention: 0 });
  });

  it('also holds when the run ends before the wait is recorded', () => {
    const ended = project(delegatingParent(), blockedRunSucceeded());
    expect(ended.cards[parent]!.condition).toBe('needs-input');
    expect(boardDelegationWait(ended.cards[parent]!)).toBeUndefined();

    const waiting = project(ended, waitStarted());
    expect(waiting.cards[parent]!.condition).toBe('active');
  });

  it('counts finished children from selected results', () => {
    const view = project(
      delegatingParent(),
      waitStarted(),
      blockedRunSucceeded(),
      resultSelected(childIds[0]!),
      resultSelected(childIds[0]!),
    );
    expect(view.cards[parent]!.condition).toBe('active');
    expect(boardDelegationWait(view.cards[parent]!)).toEqual({
      total: 3,
      finished: 1,
      needsAttention: 0,
    });
  });

  it('surfaces a blocked child as Needs input on the parent', () => {
    const view = project(
      delegatingParent(),
      waitStarted(),
      blockedRunSucceeded(),
      eventEnvelope(
        OrchestrationEventType.DelegationChildBlocked,
        { childWorkItemId: childIds[1]!, reason: 'Child terminated without success' },
        parentStream,
        next(),
      ),
    );
    expect(view.cards[parent]!.condition).toBe('needs-input');
    expect(boardDelegationWait(view.cards[parent]!)).toEqual({
      total: 3,
      finished: 0,
      needsAttention: 1,
    });
  });

  it('marks an escalated assessment as Needs input until the next assessment starts', () => {
    const attention = activationId(`${parentWorkflow}:delegate:attention`);
    const escalated = project(
      delegatingParent(),
      waitStarted(),
      blockedRunSucceeded(),
      eventEnvelope(
        OrchestrationEventType.DelegationAttentionResolved,
        {
          cohortId: 'cohort-1',
          attentionKey: 'key-1',
          activationId: attention,
          escalation: 'Which base branch should child-b use?',
        },
        parentStream,
        next(),
      ),
    );
    expect(escalated.cards[parent]!.condition).toBe('needs-input');
    expect(boardDelegationWait(escalated.cards[parent]!)).toMatchObject({ escalated: true });

    const reassessed = project(
      escalated,
      eventEnvelope(
        OrchestrationEventType.DelegationAttentionResolved,
        { cohortId: 'cohort-1', attentionKey: 'key-2', activationId: attention },
        parentStream,
        next(),
      ),
    );
    expect(reassessed.cards[parent]!.condition).toBe('active');
    expect(boardDelegationWait(reassessed.cards[parent]!)?.escalated).toBeUndefined();
  });

  it('drops a replaced child from the cohort when a corrective child is reserved', () => {
    const replacement = workId('child-a-fix');
    const view = project(
      delegatingParent(),
      waitStarted(),
      reserved([child(replacement, 'task-0-fix', 'task-0')]),
    );
    expect(boardDelegationWait(view.cards[parent]!)).toEqual({
      total: 3,
      finished: 0,
      needsAttention: 0,
    });
    expect(view.delegatedChildren[replacement]).toBe(parent);
  });

  it('returns to ordinary condition handling once the cohort joins', () => {
    const joined = project(
      delegatingParent(),
      waitStarted(),
      blockedRunSucceeded(),
      ...childIds.map((id) => resultSelected(id)),
      eventEnvelope(
        OrchestrationEventType.DelegationJoined,
        {
          cohortId: 'cohort-1',
          results: [
            {
              cohortId: 'cohort-1',
              childWorkItemId: childIds[0]!,
              outputs: [
                { name: 'findings', reference: { workItemId: childIds[0]!, revisionId: 'r1' } },
              ],
            },
          ],
        },
        parentStream,
        next(),
      ),
    );
    expect(joined.cards[parent]!.condition).toBe('ready');
    expect(boardDelegationWait(joined.cards[parent]!)).toBeUndefined();
    expect(joined.cards[parent]!.delegatedCohort).toBeUndefined();
  });

  it('leaves a failed cohort to the InstanceBlocked that follows it', () => {
    const failed = project(
      delegatingParent(),
      waitStarted(),
      blockedRunSucceeded(),
      eventEnvelope(
        OrchestrationEventType.DelegationFailed,
        { cohortId: 'cohort-1', reason: 'Child failed' },
        parentStream,
        next(),
      ),
      eventEnvelope(
        OrchestrationEventType.InstanceBlocked,
        { reason: 'Child failed' },
        parentStream,
        next(),
      ),
    );
    expect(failed.cards[parent]).toMatchObject({
      condition: 'needs-input',
      blockReason: 'Child failed',
    });
    expect(boardDelegationWait(failed.cards[parent]!)).toBeUndefined();
  });

  it('keeps a failed delegating run as Error while waiting', () => {
    const view = project(
      delegatingParent(),
      waitStarted(),
      eventEnvelope(
        ExecutionEventType.RunSucceeded,
        { outcome: { kind: 'failed' }, finishedAt: '2026-08-30T12:05:00.000Z' },
        runStream(delegatingRun),
        next(),
      ),
    );
    expect(view.cards[parent]!.condition).toBe('error');
  });
});
