import { signalName, workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { activityName } from '../../../src-next/activities/index.js';
import { z } from 'zod';
import { expect } from 'vitest';
import { resourceId } from '../../../src-next/resources/index.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-WAIT-001',
    title: 'a matching human reply resumes a blocked Activity once',
    given: ['a retry count and a revision-bound signal expectation'],
    when: ['one authorized human reply is accepted twice'],
    then: ['one fresh activation is requested without resetting the retry budget'],
  },
  async () => {
    const world = new TestWorld();
    let attempts = 0;
    world.registerActivity({
      name: activityName('implement'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.enum(['failed', 'blocked']) }).strict(),
      outcomeKinds: ['failed', 'blocked'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          attempts += 1;
          return attempts === 1 ? { kind: 'failed' } : { kind: 'blocked' };
        },
      },
    });
    world.configureWorkflow('default', {
      stages: {
        implement: {
          activity: 'implement',
          with: {},
          on: {
            failed: { retry: { max: 1 }, then: 'await-human' },
            blocked: { then: 'await-human' },
          },
        },
      },
    });
    const work = await world.createWork({ objective: 'wait for a decision' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('default'),
    });
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    await world.waitForSignal(workflow.workflowInstanceId, {
      signalKind: signalName('accepted'),
      resourceId: resourceId('resource-pr-1'),
      revision: 'abc123',
    });
    const signal = {
      kind: signalName('accepted'),
      resourceId: resourceId('resource-pr-1'),
      revision: 'abc123',
      actorId: 'owner',
      actorDecision: { authorized: true, evidenceId: 'review-decision-1' },
      providerEventId: 'github-comment-1',
    } as const;
    const accepted = await world.acceptSignal(workflow.workflowInstanceId, signal);
    const duplicate = await world.acceptSignal(workflow.workflowInstanceId, signal);
    expect(duplicate).toEqual(accepted);
    expect(accepted.retryCounts).toEqual({ 'implement:failed': 1 });
    expect(accepted.pendingActivation?.ordinal).toBe(3);
    expect(await world.events('orchestration.signal-accepted')).toHaveLength(1);
  },
);
