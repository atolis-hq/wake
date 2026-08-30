import { expect } from 'vitest';
import { correlationId } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { resourceKind } from '../../../src/resources/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { resId, workId } from '../../support/identities.js';
import { createTestResourceServices } from '../../support/resource-lookup.js';
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
    const { resources } = createTestResourceServices(journal);
    const itemId = workId('1');
    const resource = resId('1');

    await work.create({ workItemId: itemId, objective: 'Implement target spine' }, context);
    await resources.discover(
      {
        resourceId: resource,
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'repo/issues/7' },
        capabilities: [],
      },
      { ...context, commandId: 'discovery-1' },
    );
    await resources.correlate(resource, itemId, 'primary', {
      ...context,
      commandId: 'correlation-1',
    });

    expect(await work.get(itemId)).toEqual({
      workItemId: itemId,
      objective: 'Implement target spine',
      state: 'open',
      relatedWorkItems: [],
      tags: [],
      autoApprovalGranted: false,
      frozen: false,
      deleted: false,
    });
    expect((await journal.readAll(0)).map((event) => event.event.eventType)).toEqual([
      'work.item-created',
      'resources.resource-discovered',
      'resources.work-correlation-established',
    ]);
  },
);
