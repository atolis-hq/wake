import { correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActivityOutcomeKind,
  ActivityRegistry,
  activityName,
} from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  ApprovalAuthorityKind,
  ResourceTransitionSignal,
  TransitionTargetKind,
  compileWorkflow,
  createOrchestrationService,
  stageName,
} from '../../../src/orchestration/index.js';
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
          on: { done: { then: 'done' }, failed: { then: 'done', retry: { max: 1 } } },
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

it.each([false, true])(
  'preserves watch origin and existing retry counts across quota re-requests (retried %s)',
  async (retried) => {
    const { service, instance } = await startedWorkflow();
    if (retried)
      await service.acceptOutcome(
        {
          workflowInstanceId: instance.workflowInstanceId,
          activationId: instance.pendingActivation!.activationId,
          outcome: { kind: ActivityOutcomeKind.Failed },
        },
        context('count-retry'),
      );
    await service.block(instance.workflowInstanceId, 'await feedback', context('block'));
    await service.waitForSignal(
      instance.workflowInstanceId,
      {
        signalKind: ResourceTransitionSignal,
        resume: { kind: TransitionTargetKind.Stage, stage: stageName('implement') },
      },
      context('wait'),
    );
    const resumed = await service.acceptSignal(
      instance.workflowInstanceId,
      {
        kind: ResourceTransitionSignal,
        authority: { kind: ApprovalAuthorityKind.Human },
        actorId: 'review',
        providerEventId: 'feedback',
        actorDecision: { authorized: true, evidenceId: 'feedback' },
      },
      context('resume'),
    );
    expect(resumed.pendingActivation?.watchDriven).toBe(true);
    let activationId = resumed.pendingActivation!.activationId;
    for (const commandId of ['quota-first', 'quota-second']) {
      const result = await service.retryRunnerQuotaFailure(
        instance.workflowInstanceId,
        {
          activationId,
          runId: commandId,
          runnerName: 'codex',
          message: 'usage limit hit',
        },
        context(commandId),
      );
      expect(result?.pendingActivation?.watchDriven).toBe(true);
      expect(result?.pendingActivation?.activationId).not.toBe(activationId);
      expect(result?.retryCounts).toEqual(resumed.retryCounts);
      expect((await service.listPendingActivations())[0]?.priority).toMatchObject({
        watchDriven: true,
        retried,
      });
      activationId = result!.pendingActivation!.activationId;
    }
  },
);
