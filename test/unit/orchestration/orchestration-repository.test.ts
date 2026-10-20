import { correlationId, type EventJournal } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import { OrchestrationRepository } from '../../../src/orchestration/application/orchestration-repository.js';
import { OrchestrationEventType } from '../../../src/orchestration/contracts/events.js';
import {
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/contracts/identifiers.js';
import { compileWorkflow, createOrchestrationService } from '../../../src/orchestration/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

it('lists every instance with the same sequence and view load reports', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new OrchestrationRepository(journal);
  await seedTwoInstances(journal);

  const listed = await repository.list();
  expect(listed).toHaveLength(2);
  for (const entry of listed) {
    const loaded = await repository.load(entry.view!.workflowInstanceId);
    expect(entry.sequence).toBe(loaded.sequence);
    expect(entry.view).toStrictEqual(loaded.view);
  }
});

it('folds only the events after the position it holds, however long the history', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new OrchestrationRepository(journal);
  const service = await seedTwoInstances(journal);
  await repository.list();
  const readAll = vi.spyOn(journal, 'readAll');
  const readStream = vi.spyOn(journal, 'readStream');
  const position = await journal.latestGlobalPosition();

  await service.markActivationStarted(
    workflowInstanceId('workflow-1'),
    (await repository.loadRequired('workflow-1')).view.pendingActivation!.activationId,
    startContext('tail'),
  );
  const loaded = await repository.load('workflow-1');
  await repository.list();
  await repository.events();

  // Every read after the sync starts at the held position, and nothing re-reads a stream.
  expect(readAll.mock.calls.every(([after]) => after >= position)).toBe(true);
  expect(
    readStream.mock.calls.filter(([stream]) => stream.kind === 'workflow-instance'),
  ).toHaveLength(
    // append() reads the stream once to check for an already-recorded intent.
    1,
  );
  expect(loaded.sequence).toBeGreaterThan(0);
});

it('records an activation start once however many ticks retry the dispatch', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new OrchestrationRepository(journal);
  const service = await seedTwoInstances(journal);
  const id = workflowInstanceId('workflow-1');
  const activationId = (await repository.loadRequired('workflow-1')).view.pendingActivation!
    .activationId;

  for (const attempt of ['a', 'b', 'c'])
    await service.markActivationStarted(id, activationId, startContext(attempt));

  const started = (await repository.history('workflow-1')).events.filter(
    (entry) => entry.event.eventType === OrchestrationEventType.ActivityStarted,
  );
  expect(started).toHaveLength(1);
});

it('reuses the derived list across repeat calls when no new events landed', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const repository = new OrchestrationRepository(journal);
  await seedTwoInstances(journal);
  const readAllSpy = vi.spyOn(journal, 'readAll');

  await repository.list();
  readAllSpy.mockClear();
  const second = await repository.list();
  const third = await repository.list();

  expect(readAllSpy).not.toHaveBeenCalled();
  expect(second).toStrictEqual(third);
});

async function seedTwoInstances(journal: EventJournal) {
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
  const work = createWorkService(journal);
  const service = createOrchestrationService(journal, work, { default: definition });

  for (const [index, seed] of ['one', 'two'].entries()) {
    const context = {
      commandId: `cmd-${seed}`,
      correlationId: correlationId(`corr-${seed}`),
      occurredAt: '2026-07-30T12:00:00Z',
      actor: { kind: 'operator' as const, id: 'test' },
    };
    await work.create({ workItemId: workId(seed), objective: `ship ${seed}` }, context);
    await service.start(
      {
        workflowInstanceId: workflowInstanceId(`workflow-${index + 1}`),
        workItemId: workId(seed),
        workflowName: workflowName('default'),
        orchestrationGroupId: orchestrationGroupId(`group-${seed}`),
      },
      context,
    );
  }
  return service;
}

function startContext(seed: string) {
  return {
    commandId: `start-${seed}`,
    correlationId: correlationId(`corr-start-${seed}`),
    occurredAt: '2026-07-30T12:00:00Z',
    actor: { kind: 'system' as const, id: 'control-plane' },
  };
}
