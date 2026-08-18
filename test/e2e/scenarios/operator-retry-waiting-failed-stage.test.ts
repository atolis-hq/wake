import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import {
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { isOperatorRetryEligible } from '../../../src/orchestration/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-RETRY-003',
    title:
      'an operator retries a stage waiting on the failed signal after automatic retries are exhausted',
    given: ['refine permits two retries (three attempts total) before await-human'],
    when: ['an operator retries the waiting stage instead of replying to the failed signal'],
    then: ['the retry recovers the workflow the same way a human reply would'],
  },
  async () => {
    const world = new TestWorld();
    let refineAttempts = 0;
    world.registerActivity({
      name: activityName('refine'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
      outcomeKinds: ['done', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          refineAttempts += 1;
          return refineAttempts <= 3 ? { kind: 'failed' as const } : { kind: 'done' as const };
        },
      },
    });
    world.configureWorkflow('default', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'done' }, failed: { retry: { max: 2 }, then: 'await-human' } },
          requiresApproval: false,
        },
      },
    });
    const work = await world.createWork({ objective: 'recover an exhausted-retry stage' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) await world.advance(work.workItemId);

    const waiting = await world.viewWorkflow(workflow.workflowInstanceId);
    expect(waiting?.status).toBe('waiting');
    expect(waiting?.waitingFor?.signalKind).toBe('failed');
    expect(waiting !== null && isOperatorRetryEligible(waiting)).toBe(true);

    const retried = await world.orchestration.retryBlockedFailedStage(
      workflowInstanceId(workflow.workflowInstanceId),
      {
        commandId: 'operator-retry-1',
        correlationId: correlationId('scenario-3'),
        occurredAt: world.clock.now().toISOString(),
        actor: { kind: 'operator', id: 'owner' },
      },
    );
    expect(retried.status).toBe('active');
    expect(retried.pendingActivation?.ordinal).toBe(4);

    await world.advanceUntilSettled(work.workItemId);
    expect(refineAttempts).toBe(4);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
  },
);
