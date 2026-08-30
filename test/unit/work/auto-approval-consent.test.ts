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

async function openWorkItem() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const service = createWorkService(journal);
  await service.create({ workItemId: workId('1'), objective: 'Fix it' }, context);
  return { journal, service };
}

describe('Work item auto-approval consent', () => {
  it('defaults to withheld consent on a newly created work item', async () => {
    const { service } = await openWorkItem();

    expect((await service.get(workId('1')))?.autoApprovalGranted).toBe(false);
  });

  it('grants consent durably and idempotently', async () => {
    const { journal, service } = await openWorkItem();

    const granted = await service.grantAutoApproval(workId('1'), {
      ...context,
      commandId: 'grant-1',
    });
    const again = await service.grantAutoApproval(workId('1'), {
      ...context,
      commandId: 'grant-2',
    });

    expect(granted.autoApprovalGranted).toBe(true);
    expect(again.autoApprovalGranted).toBe(true);
    const grants = (await journal.readStream(stream)).filter(
      (event) => event.event.eventType === WorkEventType.AutoApprovalGranted,
    );
    expect(grants).toHaveLength(1);
  });

  it('revokes consent idempotently and never records a revocation that changes nothing', async () => {
    const { journal, service } = await openWorkItem();

    const untouched = await service.revokeAutoApproval(workId('1'), {
      ...context,
      commandId: 'revoke-0',
    });
    await service.grantAutoApproval(workId('1'), { ...context, commandId: 'grant-1' });
    const revoked = await service.revokeAutoApproval(workId('1'), {
      ...context,
      commandId: 'revoke-1',
    });

    expect(untouched.autoApprovalGranted).toBe(false);
    expect(revoked.autoApprovalGranted).toBe(false);
    const revocations = (await journal.readStream(stream)).filter(
      (event) => event.event.eventType === WorkEventType.AutoApprovalRevoked,
    );
    expect(revocations).toHaveLength(1);
  });

  it('projects consent onto the WorkItem view', async () => {
    const { journal, service } = await openWorkItem();
    await service.grantAutoApproval(workId('1'), { ...context, commandId: 'grant-1' });

    const events = await journal.readStream(stream);
    const projected = events.reduce<ReturnType<typeof workProjection.initial>>(
      (previous, event) => workProjection.project(previous, decodeWorkEvent(event)),
      workProjection.initial(stream.id),
    );

    expect(projected?.autoApprovalGranted).toBe(true);
  });

  it('decodes and projects a created event recorded before consent existed', () => {
    const legacy = decodeWorkEvent(
      eventEnvelope(WorkEventType.ItemCreated, { objective: 'Older work' }, stream),
    );

    expect(
      workProjection.project(workProjection.initial(stream.id), legacy)?.autoApprovalGranted,
    ).toBe(false);
  });
});
