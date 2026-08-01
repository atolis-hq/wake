import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../src-next/activities/index.js';
import { workflowName } from '../../src-next/orchestration/contracts/identifiers.js';
import { TestWorld } from '../e2e/support/world.js';

async function world() {
  const result = new TestWorld();
  result.registerActivity({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  result.configureWorkflow('default', {
    stages: {
      implement: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
    },
  });
  return result;
}

describe('advanceOnce', () => {
  it('does no work when no activation is pending', async () => {
    expect(await (await world()).advance()).toEqual({ kind: 'no-work' });
  });
  it('performs at most one execution attempt and never duplicates a completed activation', async () => {
    const test = await world();
    const work = await test.createWork({ objective: 'ship' });
    await test.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    expect((await test.advance(work.workItemId)).kind).toBe('progressed');
    expect(await test.advance(work.workItemId)).toEqual({ kind: 'no-work' });
    expect((await test.viewRuns()).length).toBe(1);
  });
});
