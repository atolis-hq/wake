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
import {
  compileWorkflow,
  createOrchestrationService,
  workflowDefinitionsProjection,
} from '../../../src/orchestration/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  ProjectionRunner,
} from '../../../src/persistence/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

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
  expect(instance.workflowDefinitionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.eventType === 'orchestration.workflow-definition-registered',
    ),
  ).toHaveLength(1);
  const projections = new InMemoryProjectionStore();
  await new ProjectionRunner(journal, projections, new InMemoryCheckpointStore()).runOnce(
    workflowDefinitionsProjection,
  );
  const changedDefinition = compileWorkflow(
    'default',
    {
      entry: 'first',
      stages: {
        first: { activity: 'implement', with: {}, on: { done: { then: 'second' } } },
        second: { activity: 'implement', with: {}, on: { done: { then: 'done' } } },
      },
    },
    registry,
  );
  const restarted = createOrchestrationService(
    journal,
    createWorkService(journal),
    {
      default: changedDefinition,
    },
    projections,
  );
  await createWorkService(journal).create(
    { workItemId: workId('2'), objective: 'ship again' },
    { ...context, commandId: 'create-work-2' },
  );
  const newInstance = await restarted.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-2'),
      workItemId: workId('2'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-2'),
    },
    { ...context, commandId: 'start-2' },
  );
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.eventType === 'orchestration.workflow-definition-registered',
    ),
  ).toHaveLength(2);
  expect(newInstance.workflowDefinitionFingerprint).not.toBe(
    instance.workflowDefinitionFingerprint,
  );
  expect((await restarted.listPendingActivations()).length).toBe(2);
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
  // The fingerprinted instance retains definition A after a restart that
  // compiles definition B, so A's terminal route still completes it.
  await restarted.acceptOutcome(
    {
      workflowInstanceId: instance.workflowInstanceId,
      activationId: instance.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...context, commandId: 'run-1' },
  );
  await restarted.acceptOutcome(
    {
      workflowInstanceId: instance.workflowInstanceId,
      activationId: instance.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...context, commandId: 'run-1' },
  );
  expect((await restarted.get(instance.workflowInstanceId))?.status).toBe('completed');

  // A completed instance must not regress to blocked just because a later,
  // unrelated command against it can no longer resolve its definition.
  const withoutHistoricalDefinition = createOrchestrationService(
    journal,
    createWorkService(journal),
    {},
  );
  await withoutHistoricalDefinition.acceptOutcome(
    {
      workflowInstanceId: instance.workflowInstanceId,
      activationId: instance.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    { ...context, commandId: 'missing-definition' },
  );
  const afterMissingDefinition = await withoutHistoricalDefinition.get(instance.workflowInstanceId);
  expect(afterMissingDefinition?.status).toBe('completed');
  expect(afterMissingDefinition?.blockReason).toBeUndefined();
});

it('blocks multiple instances with unresolvable definitions in one watch batch without an eventId collision', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const context = {
    commandId: 'cmd-1',
    correlationId: correlationId('corr-1'),
    occurredAt: '2026-07-30T12:00:00Z',
    actor: { kind: 'operator' as const, id: 'test' },
  };
  const work = createWorkService(journal);
  await work.create({ workItemId: workId('1'), objective: 'ship' }, context);
  await work.create(
    { workItemId: workId('2'), objective: 'ship' },
    { ...context, commandId: 'cmd-2' },
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
    },
    registry,
  );
  const service = createOrchestrationService(journal, work, { default: definition });
  const first = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-1'),
      workItemId: workId('1'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    context,
  );
  const second = await service.start(
    {
      workflowInstanceId: workflowInstanceId('workflow-2'),
      workItemId: workId('2'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('group-2'),
    },
    { ...context, commandId: 'cmd-2' },
  );

  // Neither instance's fingerprinted definition can resolve here (no current
  // 'default' definition, no projections), so both need blocking in the same
  // listWatchMatches batch below - which shares one CommandContext across
  // every matched parent.
  const withoutDefinitions = createOrchestrationService(journal, work, {});
  const sharedContext = { ...context, commandId: 'watch-1' };
  await expect(withoutDefinitions.listWatchMatches('some.event', sharedContext)).resolves.toEqual(
    [],
  );
  expect((await withoutDefinitions.get(first.workflowInstanceId))?.blockReason).toBe(
    'workflow-definition-unavailable',
  );
  expect((await withoutDefinitions.get(second.workflowInstanceId))?.blockReason).toBe(
    'workflow-definition-unavailable',
  );
});
