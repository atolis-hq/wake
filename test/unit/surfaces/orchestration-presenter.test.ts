import { describe, expect, it } from 'vitest';
import type { WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { toWorkItemKey } from '../../../src/surfaces/api/contracts/work.js';
import { presentWorkflowInstance } from '../../../src/surfaces/api/presenters/orchestration.js';
import { workId } from '../../support/identities.js';

const id = workId('orchestration-presenter');

describe('presentWorkflowInstance', () => {
  it('exposes the block reason for a blocked workflow so operators can tell why it stopped', () => {
    const view = {
      workflowInstanceId: 'workflow-1',
      workItemId: id,
      workflowName: 'default',
      orchestrationGroupId: 'group-1',
      status: 'blocked',
      pendingActivation: { activationId: 'a', activity: 'agent', status: 'completed' },
      executionFailure: { activationId: 'a', runId: 'r', reason: 'runner inspection unavailable' },
      blockReason: 'execution-recovery-ambiguous: runner inspection unavailable',
      currentStage: 'implement',
      repeatCounts: {},
      retryCounts: {},
      supplementalQueue: [],
      acceptedSignalIds: [],
      operatorRetryCommandIds: [],
      acceptedOutcomes: ['a'],
      acceptedChildCompletionIds: [],
      causalRejectionIds: [],
      childCompletionRecorded: false,
    } as unknown as WorkflowInstanceView;

    expect(presentWorkflowInstance(view, 'open').retryEligible).toBe(true);
    expect(presentWorkflowInstance(view, 'closed')).not.toHaveProperty('retryEligible');
    expect(presentWorkflowInstance(view, 'cancelled')).not.toHaveProperty('retryEligible');
    expect(presentWorkflowInstance(view)).toMatchObject({
      workItemKey: toWorkItemKey(id),
      status: 'blocked',
      blockReason: 'execution-recovery-ambiguous: runner inspection unavailable',
    });
  });

  it('omits the block reason for a workflow that is not blocked', () => {
    const view = {
      workflowInstanceId: 'workflow-2',
      workItemId: id,
      workflowName: 'default',
      orchestrationGroupId: 'group-1',
      status: 'active',
      currentStage: 'implement',
      repeatCounts: {},
      retryCounts: {},
      supplementalQueue: [],
      acceptedSignalIds: [],
      operatorRetryCommandIds: [],
      acceptedOutcomes: [],
      acceptedChildCompletionIds: [],
      causalRejectionIds: [],
      childCompletionRecorded: false,
    } as unknown as WorkflowInstanceView;

    expect(presentWorkflowInstance(view)).not.toHaveProperty('blockReason');
  });
});

it('shows only the safe block reason for a waiting failed workflow', () => {
  const view = {
    workItemId: id,
    status: 'waiting',
    waitingFor: { signalKind: 'failed' },
    blockReason: 'unconfigured outcome blocked',
    lastOutcome: { kind: 'failed', data: { reason: 'github-error' } },
    acceptedOutcomes: [],
  } as unknown as WorkflowInstanceView;
  const result = presentWorkflowInstance(view);
  expect(result).toMatchObject({
    status: 'waiting',
    displayStatus: 'failed',
    blockReason: 'unconfigured outcome blocked',
  });
  expect(JSON.stringify(result)).not.toContain('github-error');
});

it.each([
  ['failed', true],
  ['approved', false],
  ['delivery-result', false],
  ['blocked', false],
])('offers retry for %s only when the failed stage is eligible', (signalKind, eligible) => {
  const view = {
    workItemId: id,
    status: 'waiting',
    waitingFor: { signalKind },
    pendingActivation: { activationId: 'activation-1', status: 'completed' },
    acceptedOutcomes: ['activation-1'],
    lastOutcome: { kind: 'failed', data: { reason: 'github-error' } },
    blockReason: 'unconfigured outcome blocked',
  } as unknown as WorkflowInstanceView;
  const result = presentWorkflowInstance(view);
  expect(result.retryEligible === true).toBe(eligible);
  if (signalKind !== 'failed') expect(result).not.toHaveProperty('blockReason');
});
