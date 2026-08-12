import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import {
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-RETRY-002',
    title: 'an operator retries runner-failed blocked work without duplicating the activation',
    given: ['a runner that fails a stage with no configured failed transition'],
    when: ['an operator retries the blocked stage twice with the same command identity'],
    then: ['the original Run is preserved and exactly one new Run is activated'],
  },
  async () => {
    const world = new TestWorld();
    let attempts = 0;
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(),
      outcomeKinds: ['done', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          attempts += 1;
          return attempts === 1 ? { kind: 'failed' as const } : { kind: 'done' as const };
        },
      },
    });
    world.configureWorkflow('default', {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    const work = await world.createWork({ objective: 'recover blocked runner work' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });

    await world.advance(work.workItemId);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('blocked');
    expect(await world.viewRuns()).toHaveLength(1);

    const retryContext = {
      commandId: 'operator-retry-1',
      correlationId: correlationId('scenario-1'),
      occurredAt: world.clock.now().toISOString(),
      actor: { kind: 'operator' as const, id: 'owner' },
    };
    const retried = await world.orchestration.retryBlockedFailedStage(
      workflowInstanceId(workflow.workflowInstanceId),
      retryContext,
    );
    const repeated = await world.orchestration.retryBlockedFailedStage(
      workflowInstanceId(workflow.workflowInstanceId),
      retryContext,
    );
    expect(repeated).toEqual(retried);
    expect(retried.pendingActivation?.ordinal).toBe(2);

    await world.advance(work.workItemId);
    const runs = await world.viewRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.activationId)).toEqual([
      `${workflow.workflowInstanceId}:activity:1`,
      `${workflow.workflowInstanceId}:activity:2`,
    ]);
    expect(runs[0]?.outcome?.kind).toBe('failed');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
  },
);
