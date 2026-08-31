import { describe, expect, it } from 'vitest';
import { correlationId } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { createWorkService, workItemStream } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const context = {
  commandId: 'command-1',
  correlationId: correlationId('correlation-1'),
  actor: { kind: 'operator' as const, id: 'operator-1' },
  occurredAt: '2026-07-30T12:00:00.000Z',
};

describe('WorkService', () => {
  it('creates, revises, links, and reloads Work-owned views', async () => {
    const service = createWorkService(new InMemoryEventJournal(new FakeClock()));
    const work1 = workId('1');

    await expect(
      service.create({ workItemId: work1, objective: 'Original objective' }, context),
    ).resolves.toMatchObject({
      workItemId: work1,
      objective: 'Original objective',
      state: 'open',
    });
    await service.create(
      { workItemId: workId('2'), objective: 'Related objective' },
      { ...context, commandId: 'command-2' },
    );
    await service.revise(
      { workItemId: work1, objective: 'Revised objective' },
      { ...context, commandId: 'command-3' },
    );
    await service.link(
      { from: work1, to: workId('2'), relation: 'relates-to' },
      { ...context, commandId: 'command-4' },
    );

    await expect(service.get(work1)).resolves.toEqual({
      workItemId: work1,
      objective: 'Revised objective',
      state: 'open',
      relatedWorkItems: [{ workItemId: workId('2'), relation: 'relates-to' }],
      tags: [],
      autoApprovalGranted: false,
      frozen: false,
      deleted: false,
    });
  });

  it('uses event idempotency when the same command is repeated', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createWorkService(journal);
    const command = { workItemId: workId('1'), objective: 'Idempotent objective' };

    await service.create(command, context);
    await service.create(command, context);

    expect(await journal.readStream(workItemStream(workId('1')))).toHaveLength(1);
  });

  it('rejects reuse of a command event identity with different Work data', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createWorkService(journal);
    const workItemId = workId('identity-conflict');
    await service.create({ workItemId, objective: 'Original objective' }, context);

    await expect(
      service.create({ workItemId, objective: 'Different objective' }, context),
    ).rejects.toThrow('has already been used with different content');
    expect(await journal.readStream(workItemStream(workItemId))).toHaveLength(1);
  });

  it('rejects lifecycle changes after work is closed', async () => {
    const service = createWorkService(new InMemoryEventJournal(new FakeClock()));
    const work1 = workId('1');
    await service.create({ workItemId: work1, objective: 'Close me' }, context);
    await service.close(work1, 'completed', { ...context, commandId: 'command-2' });

    await expect(
      service.revise(
        { workItemId: work1, objective: 'Too late' },
        { ...context, commandId: 'command-3' },
      ),
    ).rejects.toThrow('closed');
  });

  it('freezes and unfreezes an open work item idempotently', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = createWorkService(journal);
    const item = workId('frozen');
    await service.create({ workItemId: item, objective: 'Freeze me' }, context);
    await expect(service.freeze(item, context)).resolves.toMatchObject({ frozen: true });
    await expect(
      service.unfreeze(item, { ...context, commandId: 'unfreeze' }),
    ).resolves.toMatchObject({ frozen: false });
    expect(await journal.readStream(workItemStream(item))).toHaveLength(3);
  });

  it('soft-deletes an item once and rejects later lifecycle changes', async () => {
    const service = createWorkService(new InMemoryEventJournal(new FakeClock()));
    const item = workId('deleted');
    await service.create({ workItemId: item, objective: 'Delete me' }, context);
    await expect(service.delete(item, { ...context, commandId: 'delete' })).resolves.toMatchObject({
      deleted: true,
    });
    await expect(service.freeze(item, { ...context, commandId: 'freeze' })).rejects.toThrow(
      'deleted',
    );
  });

  it('deletes a closed item, unlike other lifecycle-guarded commands', async () => {
    const service = createWorkService(new InMemoryEventJournal(new FakeClock()));
    const item = workId('closed-deleted');
    await service.create({ workItemId: item, objective: 'Close then delete me' }, context);
    await service.close(item, 'completed', { ...context, commandId: 'close' });

    await expect(service.delete(item, { ...context, commandId: 'delete' })).resolves.toMatchObject({
      deleted: true,
      state: 'closed',
    });
    await expect(
      service.delete(item, { ...context, commandId: 'delete-again' }),
    ).resolves.toMatchObject({ deleted: true, state: 'closed' });
  });
});
