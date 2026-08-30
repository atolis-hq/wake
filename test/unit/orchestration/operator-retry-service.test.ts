import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  compileWorkflow,
  createOrchestrationService,
  OperatorRetryIneligibleError,
} from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = (commandId: string, occurredAt = '2026-08-12T12:00:00Z') => ({
  commandId,
  correlationId: correlationId('operator-retry-correlation'),
  occurredAt,
  actor: { kind: 'operator' as const, id: 'owner' },
});

async function blockedWorkflow() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  await work.create(
    { workItemId: workId('operator-retry'), objective: 'retry failed work' },
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
      workflowInstanceId: workflowInstanceId('operator-retry-workflow'),
      workItemId: workId('operator-retry'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('operator-retry-group'),
    },
    context('start'),
  );
  await service.acceptOutcome(
    {
      workflowInstanceId: instance.workflowInstanceId,
      activationId: instance.pendingActivation!.activationId,
      outcome: { kind: 'failed' },
    },
    context('failed'),
  );
  return { journal, service, instance };
}

it('retries a blocked failed stage once per operator command id', async () => {
  const { service, instance } = await blockedWorkflow();

  const retried = await service.retryBlockedFailedStage(
    instance.workflowInstanceId,
    context('retry-1'),
  );
  const repeated = await service.retryBlockedFailedStage(
    instance.workflowInstanceId,
    context('retry-1'),
  );

  expect(retried.pendingActivation?.ordinal).toBe(2);
  expect(repeated).toEqual(retried);
  expect(repeated.operatorRetryCommandIds).toEqual(['retry-1']);
});

it('rejects an operator retry when the workflow is not eligible', async () => {
  const { service, instance } = await blockedWorkflow();
  await service.retryBlockedFailedStage(instance.workflowInstanceId, context('retry-1'));

  await expect(
    service.retryBlockedFailedStage(instance.workflowInstanceId, context('retry-2')),
  ).rejects.toEqual(
    expect.objectContaining({
      name: 'OperatorRetryIneligibleError',
      message: 'workflow is not in a retryable failed-stage state',
    }),
  );
  await expect(
    service.retryBlockedFailedStage(instance.workflowInstanceId, context('retry-2')),
  ).rejects.toBeInstanceOf(OperatorRetryIneligibleError);
});

it('concurrently replays a retry command with a changed occurredAt only once', async () => {
  const { journal, service, instance } = await blockedWorkflow();

  const [first, repeated] = await Promise.all([
    service.retryBlockedFailedStage(
      instance.workflowInstanceId,
      context('retry-concurrent', '2026-08-12T12:00:00Z'),
    ),
    service.retryBlockedFailedStage(
      instance.workflowInstanceId,
      context('retry-concurrent', '2026-08-12T12:01:00Z'),
    ),
  ]);

  expect(first).toEqual(repeated);
  expect(first.pendingActivation?.ordinal).toBe(2);
  expect(first.operatorRetryCommandIds).toEqual(['retry-concurrent']);
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.event.eventType === 'orchestration.operator-retry-requested',
    ),
  ).toHaveLength(1);
});
