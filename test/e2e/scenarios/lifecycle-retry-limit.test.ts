import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-LIFECYCLE-003',
    title: 'retry limit reached blocks the workflow; a human reply resumes it',
    given: ['refine permits two retries (three attempts total) before await-human'],
    when: [
      'refine fails three times, a human resumes a fourth successful attempt, then implement succeeds',
    ],
    then: [
      'only the human signal resumes the fourth attempt',
      'the retry budget is unchanged by the human-resumed attempt',
      'the workflow reaches completed',
    ],
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
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' } as const;
        },
      },
    });
    world.configureWorkflow('default', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'implement' }, failed: { retry: { max: 2 }, then: 'await-human' } },
          requiresApproval: false,
        },
        implement: {
          activity: 'implement',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    const work = await world.createWork({ objective: 'ship despite friction' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) await world.advance(work.workItemId);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('waiting');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.retryCounts).toEqual({
      'refine:failed': 2,
    });
    const accepted = await world.acceptSignal(workflow.workflowInstanceId, {
      kind: 'failed' as never,
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'human-reply-1' },
      providerEventId: 'github-comment-1',
    });
    expect(accepted.retryCounts).toEqual({ 'refine:failed': 2 });
    expect(accepted.pendingActivation?.ordinal).toBe(4);
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    expect(refineAttempts).toBe(4);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
    expect(await world.events('orchestration.signal-accepted')).toHaveLength(1);
  },
);
