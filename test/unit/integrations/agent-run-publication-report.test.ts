import { expect, it } from 'vitest';

import { BuiltInActivityName } from '../../../src/activities/index.js';
import { agentRunReportInput } from '../../../src/integrations/application/agent-run-publication-report.js';
import {
  ApprovedSignal,
  ResourceTransitionSignal,
  WorkflowStatus,
} from '../../../src/orchestration/index.js';

const run = { runId: 'run-1', finishedAt: '2026-08-08T00:01:00.000Z' } as never;

function mergeWorkflow(signalKind: string) {
  return {
    workflowInstanceId: 'wf-1',
    workItemId: 'work-1',
    status: WorkflowStatus.Waiting,
    waitingFor: { signalKind },
    pendingActivation: {
      activationId: 'activation-1',
      activity: BuiltInActivityName.PullRequestMerge,
    },
  } as never;
}

it('keeps /approved guidance for a default approval wait at the merge stage', () => {
  const workflow = mergeWorkflow(ApprovedSignal);
  const input = agentRunReportInput(run, 'merge', workflow, [workflow]);
  expect(input).toMatchObject({ awaitingApproval: true, mergeStageApproval: true });
  expect(input).not.toHaveProperty('awaitingMerge');
});

it('uses provider-merge guidance for a resource-transition merge wait', () => {
  const workflow = mergeWorkflow(ResourceTransitionSignal);
  const input = agentRunReportInput(run, 'merge', workflow, [workflow]);
  expect(input).toMatchObject({ awaitingMerge: true });
  expect(input).not.toHaveProperty('awaitingApproval');
  expect(input).not.toHaveProperty('mergeStageApproval');
});
