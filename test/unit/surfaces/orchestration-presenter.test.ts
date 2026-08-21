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
      blockReason: 'run-ambiguous-after-3-attempts',
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

    expect(presentWorkflowInstance(view)).toMatchObject({
      workItemKey: toWorkItemKey(id),
      status: 'blocked',
      blockReason: 'run-ambiguous-after-3-attempts',
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
