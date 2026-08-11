import { describe, expect, it } from 'vitest';
import {
  decodeWorkEvent,
  selectWorkEvent,
  WorkEventType,
  workItemStream,
} from '../../../src/work/index.js';
import { eventEnvelope } from '../../support/event-envelope.js';
import { workId } from '../../support/identities.js';

const stream = workItemStream(workId('1'));
const samples = [
  [WorkEventType.ItemCreated, { objective: 'Ship it' }],
  [WorkEventType.ObjectiveRevised, { objective: 'Ship it safely' }],
  [WorkEventType.ItemLinked, { to: workId('2'), relation: 'parent-of' }],
  [WorkEventType.ItemClosed, { reason: 'done' }],
  [WorkEventType.ItemCancelled, { reason: 'obsolete' }],
  [WorkEventType.AutoApprovalGranted, {}],
  [WorkEventType.AutoApprovalRevoked, {}],
  [WorkEventType.ItemFrozen, {}],
  [WorkEventType.ItemUnfrozen, {}],
  [WorkEventType.ItemDeleted, {}],
] as const;

describe('Work event contract', () => {
  it('decodes every declared event with its exact payload and stream', () => {
    expect(
      samples.map(([type, payload]) => decodeWorkEvent(eventEnvelope(type, payload, stream))),
    ).toHaveLength(Object.keys(WorkEventType).length);
  });

  it('rejects an owned event with an unknown type', () => {
    expect(() => decodeWorkEvent(eventEnvelope('work.unknown', {}, stream))).toThrow(
      /event-7.*position 7.*work\.unknown/i,
    );
  });

  it('rejects an owned event with a malformed or non-exact payload', () => {
    expect(() =>
      decodeWorkEvent(
        eventEnvelope(WorkEventType.ItemCreated, { objective: 'Ship it', extra: true }, stream),
      ),
    ).toThrow();
  });

  it('rejects an owned event on the wrong stream kind', () => {
    expect(() =>
      decodeWorkEvent(
        eventEnvelope(
          WorkEventType.ItemCreated,
          { objective: 'Ship it' },
          {
            kind: 'resource',
            id: 'resource-1',
          },
        ),
      ),
    ).toThrow();
  });

  it.each([
    eventEnvelope(
      WorkEventType.ItemCreated,
      { objective: 'Ship it' },
      { kind: 'work-item', id: 'invalid-work-id' },
    ),
    eventEnvelope(
      WorkEventType.ItemLinked,
      { to: 'invalid-work-id', relation: 'parent-of' },
      stream,
    ),
  ])('reports invalid branded IDs through the Work decoder context', (event) => {
    expect(() => decodeWorkEvent(event)).toThrow(
      /Invalid Work event event-7 at global position 7/i,
    );
  });

  it('selects unrelated namespaces as null but throws for invalid owned events', () => {
    expect(selectWorkEvent(eventEnvelope('resources.resource-discovered', {}, stream))).toBeNull();
    expect(() => selectWorkEvent(eventEnvelope('work.unknown', {}, stream))).toThrow();
  });
});
