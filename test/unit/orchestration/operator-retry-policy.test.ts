import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  activationId,
  activityName,
  ActivityOutcomeKind,
  ActivityRegistry,
} from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  ActivityActivationStatus,
  WorkflowStatus,
} from '../../../src/orchestration/contracts/vocabulary.js';
import {
  acceptActivityOutcome,
  compileWorkflow,
  foldWorkflowInstance,
  isOperatorRetryEligible,
  orchestrationActivityOutcome,
  OrchestrationEventType,
  requestOperatorRetry,
  startInstance,
} from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

function blockedFailedFixture() {
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('implement'),
    inputSchema: z.object({ attempt: z.literal('operator') }).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
    outcomeKinds: ['done', 'failed'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: { attempt: 'operator' },
          execution: { runnerPool: 'recovery' },
          on: { done: { then: 'done' } },
        },
      },
    },
    activities,
  );
  const started = startInstance({
    workflowInstanceId: workflowInstanceId('workflow-1'),
    workItemId: workId('1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    definition,
    occurredAt: '2026-08-12T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'start-command',
  });
  if (started.kind !== 'append') throw new Error('expected start decision');
  const beforeFailure = foldWorkflowInstance(started.events)!;
  const failed = acceptActivityOutcome(definition, beforeFailure, {
    activationId: beforeFailure.pendingActivation!.activationId,
    outcome: orchestrationActivityOutcome({ kind: ActivityOutcomeKind.Failed }),
    occurredAt: '2026-08-12T12:01:00.000Z',
    causationId: 'failed-run',
  });
  if (failed.kind !== 'append') throw new Error('expected failed outcome decision');
  return { definition, state: foldWorkflowInstance([...started.events, ...failed.events])! };
}

const retryInput = {
  commandId: 'operator-retry-command',
  occurredAt: '2026-08-12T12:02:00.000Z',
  causationId: 'operator-retry-command',
};

describe('operator retry policy', () => {
  it('rejects an empty operator retry command id', () => {
    const { definition, state } = blockedFailedFixture();

    expect(requestOperatorRetry(definition, state, { ...retryInput, commandId: '' })).toEqual({
      kind: 'ignored',
      reason: 'operator retry command id is required',
    });
  });

  it('records recovery then requests the current stage with its next ordinal and configuration', () => {
    const { definition, state } = blockedFailedFixture();

    const decision = requestOperatorRetry(definition, state, retryInput);

    expect(decision.kind).toBe('append');
    if (decision.kind !== 'append') return;
    expect(decision.events).toHaveLength(2);
    expect(decision.events.map((event) => event.eventType)).toEqual([
      OrchestrationEventType.OperatorRetryRequested,
      OrchestrationEventType.ActivityRequested,
    ]);
    expect(decision.events[0]!.payload).toEqual({
      activationId: state.pendingActivation!.activationId,
      commandId: retryInput.commandId,
    });
    expect(decision.events[1]!.payload).toMatchObject({
      activationId: 'workflow-1:activity:2',
      ordinal: 2,
      activity: activityName('implement'),
      input: { attempt: 'operator' },
      execution: { runnerPool: 'recovery' },
    });
    expect(isOperatorRetryEligible(state)).toBe(true);
  });

  it.each([
    [
      'active',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        status: WorkflowStatus.Active,
      }),
    ],
    [
      'completed',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        status: WorkflowStatus.Completed,
      }),
    ],
    [
      'waiting',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        status: WorkflowStatus.Waiting,
      }),
    ],
    [
      'differently blocked',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        blockReason: 'manual block',
      }),
    ],
    [
      'supplemental',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        pendingActivation: { ...state.pendingActivation!, supplemental: true },
      }),
    ],
    [
      'follow-on',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        pendingActivation: { ...state.pendingActivation!, followOnIndex: 0 },
      }),
    ],
    [
      'pending activation',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        pendingActivation: {
          ...state.pendingActivation!,
          status: ActivityActivationStatus.Pending,
        },
      }),
    ],
    [
      'unaccepted activation',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        acceptedOutcomes: [],
      }),
    ],
    [
      'a different accepted activation',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        acceptedOutcomes: [activationId('workflow-1:activity:0')],
      }),
    ],
    [
      'non-failed outcome',
      (state: ReturnType<typeof blockedFailedFixture>['state']) => ({
        ...state,
        lastOutcome: orchestrationActivityOutcome({ kind: ActivityOutcomeKind.Done }),
      }),
    ],
  ])('rejects %s states', (_name, change) => {
    const { definition, state } = blockedFailedFixture();
    const candidate = change(state);

    expect(isOperatorRetryEligible(candidate)).toBe(false);
    expect(requestOperatorRetry(definition, candidate, retryInput)).toEqual({
      kind: 'ignored',
      reason: 'workflow is not blocked for an unconfigured failed outcome',
    });
  });
});
