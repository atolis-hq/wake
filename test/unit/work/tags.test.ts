import { describe, expect, it } from 'vitest';
import { correlationId } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import {
  createWorkService,
  decodeWorkEvent,
  WorkEventType,
  workItemStream,
  workProjection,
} from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

const context = {
  commandId: 'command-1',
  correlationId: correlationId('correlation-1'),
  actor: { kind: 'operator' as const, id: 'operator-1' },
  occurredAt: '2026-07-30T12:00:00.000Z',
};
const stream = workItemStream(workId('1'));

describe('Work item tags', () => {
  it('carries tags on the intake command and the created event', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createWorkService(journal);

    await service.create({ workItemId: workId('1'), objective: 'Fix it', tags: ['bug'] }, context);

    const events = await journal.readStream(stream);
    expect(events[0]?.event.eventType).toBe(WorkEventType.ItemCreated);
    expect(decodeWorkEvent(events[0]!).event.payload).toMatchObject({ tags: ['bug'] });
  });

  it('projects tags onto the WorkItem view', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createWorkService(journal);

    const view = await service.create(
      { workItemId: workId('1'), objective: 'Fix it', tags: ['bug', 'urgent'] },
      context,
    );

    expect(view.tags).toEqual(['bug', 'urgent']);
    const projected = workProjection.project(
      workProjection.initial(stream.id),
      decodeWorkEvent((await journal.readStream(stream))[0]!),
    );
    expect(projected?.tags).toEqual(['bug', 'urgent']);
  });

  it('decodes and projects a created event recorded before tags existed', () => {
    const legacy = decodeWorkEvent(
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Older work' }, stream),
    );

    expect(workProjection.project(workProjection.initial(stream.id), legacy)?.tags).toEqual([]);
  });
});
