import { resourceKind } from '../../../src-next/resources/index.js';
import { expect } from 'vitest';
import { correlationId } from '../../../src-next/kernel/index.js';
import { InMemoryEventJournal } from '../../../src-next/persistence/index.js';
import { createResourceService, resourceId } from '../../../src-next/resources/index.js';
import { createWorkService, workItemId } from '../../../src-next/work/index.js';
import { defineScenario } from '../support/scenario.js';
import { FakeClock } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-WORK-001',
    title: 'work intake associates a provider resource without giving Work provider identity',
    given: ['integration.fake.resource-discovered repo/issues/7'],
    when: ['work intake is accepted'],
    then: [
      'work.item-created',
      'resources.resource-discovered',
      'resources.work-correlation-established role primary',
      'the WorkItem contains no provider identity',
    ],
  },
  async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const context = {
      commandId: 'intake-1',
      correlationId: correlationId('correlation-1'),
      actor: { kind: 'integration' as const, id: 'fake' },
      occurredAt: '2026-07-30T12:00:00.000Z',
    };
    const work = createWorkService(journal);
    const resources = createResourceService(journal);
    const workId = workItemId('work-1');
    const resource = resourceId('resource-1');

    await work.create({ workItemId: workId, objective: 'Implement target spine' }, context);
    await resources.discover(
      {
        resourceId: resource,
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'repo/issues/7' },
        capabilities: [],
      },
      { ...context, commandId: 'discovery-1' },
    );
    await resources.correlate(resource, workId, 'primary', {
      ...context,
      commandId: 'correlation-1',
    });

    expect(await work.get(workId)).toEqual({
      workItemId: 'work-1',
      objective: 'Implement target spine',
      state: 'open',
      relatedWorkItems: [],
    });
    expect((await journal.readAll(0)).map((event) => event.eventType)).toEqual([
      'work.item-created',
      'resources.resource-discovered',
      'resources.work-correlation-established',
    ]);
  },
);
