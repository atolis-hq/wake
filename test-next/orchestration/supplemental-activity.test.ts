import {
  commandName,
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { workId } from '../support/identities.js';
import { ActivityRegistry, activityName } from '../../src-next/activities/index.js';
import { correlationId } from '../../src-next/kernel/index.js';
import { compileWorkflow, createOrchestrationService } from '../../src-next/orchestration/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { createWorkService } from '../../src-next/work/index.js';
import { FakeClock } from '../e2e/support/world.js';

async function fixture(actor: 'operator' | 'agent' = 'operator') {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const context = {
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-07-30T12:00:00.000Z',
    actor: { kind: actor, id: actor === 'operator' ? 'owner' : 'runner' },
  } as const;
  await work.create(
    { workItemId: workId('1'), objective: 'ship' },
    { ...context, commandId: 'create-work', actor: { kind: 'operator', id: 'owner' } },
  );
  const activities = new ActivityRegistry();
  for (const name of ['implement', 'review']) {
    activities.register({
      name: activityName(name),
      inputSchema: z.object({ prompt: z.string() }).strict(),
      outcomeSchema: z.object({ kind: z.enum(['done', 'blocked']) }).strict(),
      outcomeKinds: ['done', 'blocked'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          return { kind: 'done' };
        },
      },
    });
  }
  const definition = compileWorkflow(
    'default',
    {
      commands: {
        '/codereview': {
          activity: 'review',
          with: { prompt: 'review the current change' },
          allowedActors: ['operator', 'integration'],
        },
      },
      stages: {
        implement: {
          activity: 'implement',
          with: { prompt: 'implement' },
          on: {
            done: { then: 'done' },
            blocked: { then: 'await-human' },
          },
        },
      },
    },
    activities,
  );
  const service = createOrchestrationService(journal, work, { default: definition });
  const instance = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    { ...context, commandId: 'start', actor: { kind: 'operator', id: 'owner' } },
  );
  return { service, instance, context };
}

describe('supplemental Activity commands', () => {
  it('queues a configured supplemental Activity behind an active Run', async () => {
    const { service, instance, context } = await fixture();
    await service.markActivationStarted(
      instance.workflowInstanceId,
      instance.pendingActivation!.activationId,
      { ...context, commandId: 'run-started' },
    );
    const queued = await service.requestSupplementalActivity(
      instance.workflowInstanceId,
      { command: commandName('/codereview') },
      { ...context, commandId: 'command-1' },
    );
    expect(queued.pendingActivation).toMatchObject({
      activity: 'implement',
      status: 'running',
    });
    expect(queued.supplementalQueue).toEqual([
      {
        activity: 'review',
        input: { prompt: 'review the current change' },
        requestedBy: 'owner',
      },
    ]);
  });

  it('returns to the same primary stage after a supplemental Activity completes', async () => {
    const { service, instance, context } = await fixture();
    await service.requestSupplementalActivity(
      instance.workflowInstanceId,
      { command: commandName('/codereview') },
      { ...context, commandId: 'command-1' },
    );
    const reviewing = await service.acceptOutcome(
      {
        workflowInstanceId: instance.workflowInstanceId,
        activationId: instance.pendingActivation!.activationId,
        outcome: { kind: 'done' },
      },
      { ...context, commandId: 'run-1' },
    );
    expect(reviewing.pendingActivation).toMatchObject({
      activity: 'review',
      supplemental: true,
    });
    const resumed = await service.acceptOutcome(
      {
        workflowInstanceId: instance.workflowInstanceId,
        activationId: reviewing.pendingActivation!.activationId,
        outcome: { kind: 'done' },
      },
      { ...context, commandId: 'run-2' },
    );
    expect(resumed.currentStage).toBe('implement');
    expect(resumed.pendingActivation).toMatchObject({
      activity: 'implement',
      ordinal: 3,
    });
    expect(resumed.supplementalQueue).toEqual([]);
  });

  it('rejects an unknown or unauthorised command', async () => {
    const authorized = await fixture();
    await expect(
      authorized.service.requestSupplementalActivity(
        authorized.instance.workflowInstanceId,
        { command: commandName('/unknown') },
        { ...authorized.context, commandId: 'unknown' },
      ),
    ).rejects.toThrow(/Unknown supplemental command/);

    const unauthorized = await fixture('agent');
    await expect(
      unauthorized.service.requestSupplementalActivity(
        unauthorized.instance.workflowInstanceId,
        { command: commandName('/codereview') },
        { ...unauthorized.context, commandId: 'unauthorized' },
      ),
    ).rejects.toThrow(/not authorised/);
  });

  it('does not allow a supplemental command to bypass a blocked destructive gate', async () => {
    const { service, instance, context } = await fixture();
    await service.acceptOutcome(
      {
        workflowInstanceId: instance.workflowInstanceId,
        activationId: instance.pendingActivation!.activationId,
        outcome: { kind: 'blocked' },
      },
      { ...context, commandId: 'block' },
    );
    await expect(
      service.requestSupplementalActivity(
        instance.workflowInstanceId,
        { command: commandName('/codereview') },
        { ...context, commandId: 'bypass' },
      ),
    ).rejects.toThrow(/active WorkflowInstance/);
  });
});
