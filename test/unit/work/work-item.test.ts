import { describe, expect, it } from 'vitest';
import { createEventDraft } from '../../../src/kernel/index.js';
import {
  decodeWorkEvent,
  foldWorkItem,
  type WorkEvent,
  workItemStream,
} from '../../../src/work/index.js';
import { workId } from '../../support/identities.js';

const stream = workItemStream(workId('1'));

function event(eventType: string, payload: unknown, sequence: number): WorkEvent {
  return decodeWorkEvent({
    ...createEventDraft({
      eventId: `event-${sequence}`,
      eventType,
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'command-1',
      actor: { kind: 'operator', id: 'operator-1' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload,
    }),
    recordedAt: '2026-07-30T12:00:00.000Z',
    sequence,
    globalPosition: sequence,
  });
}

describe('WorkItem', () => {
  it('creates Wake-owned work without a provider identity', () => {
    expect(
      foldWorkItem([event('work.item-created', { objective: 'Implement the target spine' }, 1)]),
    ).toEqual({
      workItemId: workId('1'),
      objective: 'Implement the target spine',
      state: 'open',
      relatedWorkItems: [],
      tags: [],
      autoApprovalGranted: false,
      frozen: false,
      deleted: false,
    });
  });

  it('rejects an empty objective', () => {
    expect(() => foldWorkItem([event('work.item-created', { objective: '   ' }, 1)])).toThrow();
  });

  it('replays objective revisions in stream order', () => {
    expect(
      foldWorkItem([
        event('work.item-created', { objective: 'First objective' }, 1),
        event('work.objective-revised', { objective: 'Second objective' }, 2),
        event('work.objective-revised', { objective: 'Final objective' }, 3),
      ]),
    ).toMatchObject({ objective: 'Final objective' });
  });

  it('links two WorkItems with a typed work relation', () => {
    expect(
      foldWorkItem([
        event('work.item-created', { objective: 'First objective' }, 1),
        event('work.item-linked', { to: workId('2'), relation: 'parent-of' }, 2),
      ]),
    ).toMatchObject({
      relatedWorkItems: [{ workItemId: workId('2'), relation: 'parent-of' }],
    });
  });

  it('does not expose workflow stage or Run state in WorkItemView', () => {
    const view = foldWorkItem([event('work.item-created', { objective: 'An objective' }, 1)]);

    expect(view).not.toHaveProperty('stage');
    expect(view).not.toHaveProperty('lastRunId');
  });
});
