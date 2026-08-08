import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-LIFECYCLE-002',
    title: 'each stage recovers independently after its own failed attempts',
    given: ['refine permits one retry and implement permits two retries, on the same workflow'],
    when: ['refine fails once then succeeds; implement fails twice then succeeds'],
    then: ['each stage retries only as many times as it actually failed', 'the two stages retry counts are tracked independently', 'the workflow still reaches completed'],
  },
  async () => {
    const world = new TestWorld();
    let refineAttempts = 0;
    let implementAttempts = 0;
    world.registerActivity({ name: activityName('refine'), inputSchema: z.object({}).strict(), outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(), outcomeKinds: ['done', 'failed'], resources: [], executionKind: 'deterministic', handler: { async execute() { refineAttempts += 1; return refineAttempts === 1 ? { kind: 'failed' as const } : { kind: 'done' as const }; } } });
    world.registerActivity({ name: activityName('implement'), inputSchema: z.object({}).strict(), outcomeSchema: z.object({ kind: z.enum(['done', 'failed']) }).strict(), outcomeKinds: ['done', 'failed'], resources: [], executionKind: 'deterministic', handler: { async execute() { implementAttempts += 1; return implementAttempts <= 2 ? { kind: 'failed' as const } : { kind: 'done' as const }; } } });
    world.configureWorkflow('default', { stages: {
      refine: { activity: 'refine', with: {}, execution: { workspace: 'none' }, on: { done: { then: 'implement' }, failed: { retry: { max: 1 }, then: 'await-human' } } },
      implement: { activity: 'implement', with: {}, execution: { workspace: 'none' }, on: { done: { then: 'done' }, failed: { retry: { max: 2 }, then: 'await-human' } } },
    } });
    const work = await world.createWork({ objective: 'ship with hiccups' });
    const workflow = await world.startWorkflow({ workItemId: work.workItemId, workflowName: workflowName('default') });
    for (let attempt = 0; attempt < 5; attempt += 1) await world.advance(work.workItemId);
    expect(refineAttempts).toBe(2);
    expect(implementAttempts).toBe(3);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.retryCounts).toEqual({ 'refine:failed': 1, 'implement:failed': 2 });
    expect((await world.viewRuns()).map((run) => run.outcome?.kind)).toEqual(['failed', 'done', 'failed', 'failed', 'done']);
    expect(await world.events('orchestration.retry-counted')).toHaveLength(3);
  },
);
