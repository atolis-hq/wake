import { correlationId } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { compileWorkflow, createOrchestrationService } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = (commandId: string, occurredAt = '2026-08-19T12:00:00Z') => ({
  commandId,
  correlationId: correlationId('runner-quota-retry-correlation'),
  occurredAt,
  actor: { kind: 'system' as const, id: 'control-plane' },
});

async function startedWorkflow() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  await work.create(
    { workItemId: workId('runner-quota-retry'), objective: 'retry after quota' },
    context('work'),
  );
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
    outcomeKinds: ['done', 'failed'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' as const };
      },
    },
  });
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    },
    registry,
  );
  const service = createOrchestrationService(journal, work, { default: definition });
  const instance = await service.start(
    {
      workflowInstanceId: workflowInstanceId('runner-quota-retry-workflow'),
      workItemId: workId('runner-quota-retry'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('runner-quota-retry-group'),
    },
    context('start'),
  );
  return { service, instance };
}

it('resolves the pending activation and requests a fresh one without publishing a workflow outcome', async () => {
  const { service, instance } = await startedWorkflow();
  const pendingActivationId = instance.pendingActivation!.activationId;

  const result = await service.retryRunnerQuotaFailure(
    instance.workflowInstanceId,
    {
      activationId: pendingActivationId,
      runId: 'run-1',
      runnerName: 'codex',
      message: 'usage limit hit',
    },
    context('quota-retry-1'),
  );

  expect(result?.acceptedOutcomes).toContain(pendingActivationId);
  expect(result?.pendingActivation).toBeDefined();
  expect(result?.pendingActivation?.activationId).not.toBe(pendingActivationId);
  expect(result?.retryCounts).toEqual({});
  expect(result?.lastOutcome).toBeUndefined();
});
