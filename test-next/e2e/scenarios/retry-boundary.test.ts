import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-RETRY-001',
    title: 'a retry-safe outcome creates a fresh activation and Run',
    given: ['a stage with one permitted workflow retry'],
    when: ['attempt one fails safely and attempt two succeeds'],
    then: ['both Runs remain immutable and the durable retry count is one'],
  },
  async () => {
    const world = new TestWorld();
    let attempts = 0;
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z
        .object({
          kind: z.enum(['done', 'failed']),
          data: z.object({ retrySafety: z.literal('safe-to-retry') }).optional(),
        })
        .strict(),
      outcomeKinds: ['done', 'failed'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          attempts += 1;
          return attempts === 1
            ? { kind: 'failed', data: { retrySafety: 'safe-to-retry' as const } }
            : { kind: 'done' };
        },
      },
    });
    world.configureWorkflow('default', {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: {
            done: { then: 'done' },
            failed: { retry: { max: 1 }, then: 'await-human' },
          },
        },
      },
    });
    const work = await world.createWork({ objective: 'retry safely' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    const runs = await world.viewRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.activationId)).toEqual([
      `${workflow.workflowInstanceId}:activity:1`,
      `${workflow.workflowInstanceId}:activity:2`,
    ]);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'implement:failed': 1,
    });
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
  },
);
