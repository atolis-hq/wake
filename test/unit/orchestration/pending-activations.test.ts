import { correlationId, createProjectionProcessor, EventProcessorHost } from '@atolis-hq/eventing';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActivityExecutionKind,
  activityName,
  ActivityOutcomeKind,
  ActivityRegistry,
} from '../../../src/activities/index.js';
import {
  compileWorkflow,
  createAgentActivityClassifier,
  createOrchestrationService,
  orchestrationGroupId,
  workflowDefinitionsProjection,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

function registryFor(name: string) {
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName(name),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal(ActivityOutcomeKind.Done) }).strict(),
    outcomeKinds: [ActivityOutcomeKind.Done],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: { execute: async () => ({ kind: ActivityOutcomeKind.Done }) },
  });
  return registry;
}

it('lists healthy work alongside a historical definition containing a removed activity', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const projections = new InMemoryProjectionStore();
  const work = createWorkService(journal);
  const context = (commandId: string) => ({
    commandId,
    correlationId: correlationId('historical-priority'),
    occurredAt: clock.now().toISOString(),
    actor: { kind: 'operator' as const, id: 'owner' },
  });
  const definitionFor = (name: string, registry: ActivityRegistry) =>
    compileWorkflow(
      name,
      {
        stages: {
          main: {
            activity: name,
            with: {},
            requiresApproval: false,
            on: { done: { then: 'done' } },
          },
        },
      },
      registry,
    );
  const { remainingAgentSteps: _legacyCosts, ...legacy } = definitionFor(
    'removed',
    registryFor('removed'),
  );
  const original = createOrchestrationService(journal, work, { removed: legacy });
  await work.create({ workItemId: workId('legacy'), objective: 'old work' }, context('create-old'));
  await original.start(
    {
      workflowInstanceId: workflowInstanceId('legacy'),
      workItemId: workId('legacy'),
      workflowName: workflowName('removed'),
      orchestrationGroupId: orchestrationGroupId('legacy'),
    },
    context('start-old'),
  );
  await new EventProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    clock,
  ).runOnce(createProjectionProcessor(workflowDefinitionsProjection, projections));

  const currentRegistry = registryFor('healthy');
  const classifier = createAgentActivityClassifier(currentRegistry);
  const restarted = createOrchestrationService(
    journal,
    work,
    { healthy: definitionFor('healthy', currentRegistry) },
    projections,
    classifier,
  );
  await work.create(
    { workItemId: workId('healthy'), objective: 'current work' },
    context('create-new'),
  );
  await restarted.start(
    {
      workflowInstanceId: workflowInstanceId('healthy'),
      workItemId: workId('healthy'),
      workflowName: workflowName('healthy'),
      orchestrationGroupId: orchestrationGroupId('healthy'),
    },
    context('start-new'),
  );

  expect(await restarted.listPendingActivations()).toEqual([
    expect.objectContaining({
      workflow: expect.objectContaining({ workItemId: workId('legacy') }),
      priority: { remainingAgentSteps: 1, watchDriven: false, retried: false },
    }),
    expect.objectContaining({
      workflow: expect.objectContaining({ workItemId: workId('healthy') }),
      priority: { remainingAgentSteps: 0, watchDriven: false, retried: false },
    }),
  ]);
  expect(classifier(activityName('removed'))).toBe(true);
  expect(classifier(activityName('healthy'))).toBe(false);
});
