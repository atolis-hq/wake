import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { compileWorkflow, createOrchestrationService } from '../../../src/orchestration/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { resourceStream } from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { resId, workId } from '../../support/identities.js';

it('uses the Work status vocabulary when checking whether work is open', async () => {
  const source = await readFile(
    new URL('../../../src/orchestration/application/start-workflow.ts', import.meta.url),
    'utf8',
  );
  expect(source).toContain('item.state !== WorkStatus.Open');
  expect(source).not.toContain('item.state !== PullRequestState.Open');
});

it('persists instances and accepts outcomes idempotently', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const context = {
    commandId: 'cmd-1',
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-07-30T12:00:00Z',
    actor: { kind: 'operator' as const, id: 'test' },
  };
  await createWorkService(journal).create({ workItemId: workId('1'), objective: 'ship' }, context);
  const registry = new ActivityRegistry();
  registry.register({
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
  const service = createOrchestrationService(journal, createWorkService(journal), {
    default: definition,
  });
  const instance = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    context,
  );
  expect((await service.listPendingActivations()).length).toBe(1);
  await expect(
    service.acceptOutcome(
      {
        workflowInstanceId: instance.workflowInstanceId,
        activationId: instance.pendingActivation!.activationId,
        outcome: {
          kind: 'waiting',
          data: { intentEventId: 'intent-1', signalKind: 'needs_input' },
        },
      },
      { ...context, commandId: 'invalid-waiting' },
    ),
  ).rejects.toThrow(/invalid signal name.*needs_input/i);
  await service.acceptOutcome(
    {
      workflowInstanceId: instance.workflowInstanceId,
      activationId: instance.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...context, commandId: 'run-1' },
  );
  await service.acceptOutcome(
    {
      workflowInstanceId: instance.workflowInstanceId,
      activationId: instance.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...context, commandId: 'run-1' },
  );
  expect((await service.get(instance.workflowInstanceId))?.status).toBe('completed');
});

it('matches a failing-checks watch only for failed check events', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const context = {
    commandId: 'watch-matching',
    correlationId: correlationId('watch-matching'),
    occurredAt: '2026-07-30T12:00:00Z',
    actor: { kind: 'operator' as const, id: 'test' },
  };
  await createWorkService(journal).create(
    { workItemId: workId('watch'), objective: 'ship' },
    context,
  );
  const registry = new ActivityRegistry();
  registry.register({
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
      watches: [
        {
          id: 'failed-checks',
          while: { stages: ['implement'], statuses: ['active'] },
          on: { events: ['pr.checks-changed'] },
          where: { checks: 'failing' },
          workflow: 'default',
          maxPerGroup: 1,
        },
      ],
    },
    registry,
  );
  const service = createOrchestrationService(journal, createWorkService(journal), {
    default: definition,
  });
  await service.start(
    {
      workflowInstanceId: workflowInstanceId('watch-workflow'),
      workItemId: workId('watch'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('watch-group'),
    },
    context,
  );
  const stream = resourceStream(resId('watch'));

  await expect(
    service.listWatchMatches(eventEnvelope('pr.checks-changed', { checks: 'failing' }, stream)),
  ).resolves.toHaveLength(1);
  await expect(
    service.listWatchMatches(eventEnvelope('pr.checks-changed', { checks: 'passing' }, stream)),
  ).resolves.toHaveLength(0);
  await expect(
    service.listWatchMatches(
      eventEnvelope('pr.review-accepted', { revision: 'revision-1', actorId: 'reviewer' }, stream),
    ),
  ).resolves.toHaveLength(0);
});
