import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createEventData,
  createRelation,
  type Brand,
  type EntityRef,
  type EventData,
  type EventDataInput,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
  type RelationDefinition,
} from '../../../src/kernel/index.js';

function workDataInput<Stream extends EntityRef>(stream: Stream) {
  return {
    eventId: 'evt-1',
    eventType: 'work.item-created',
    occurredAt: '2026-07-30T12:00:00.000Z',
    correlationId: 'corr-1',
    causationId: 'cmd-1',
    actor: { kind: 'system', id: 'wake' },
    source: { kind: 'internal', id: 'wake' },
    stream,
    payload: { objective: 'Ship the change' },
  } as const;
}

describe('event envelope', () => {
  it('retains a branded stream id', () => {
    type WorkItemId = Brand<string, 'WorkItemId'>;

    const workItemId = 'work-1' as WorkItemId;

    const stream: EntityRef<'work-item', WorkItemId> = {
      kind: 'work-item',
      id: workItemId,
    };

    expectTypeOf(stream).toEqualTypeOf<EntityRef<'work-item', WorkItemId>>();
    expect(stream.id).toBe(workItemId);
  });

  it('maps each event type to its exact payload and stream', () => {
    type WorkItemId = Brand<string, 'WorkItemId'>;

    type WorkStream = EntityRef<'work-item', WorkItemId>;

    interface WorkEventPayloads {
      readonly 'work.item-created': { readonly objective: string };
      readonly 'work.item-closed': { readonly reason: string };
    }

    type WorkEvent = EventUnion<WorkEventPayloads, WorkStream>;

    type WorkEventData = EventDataUnion<WorkEventPayloads, WorkStream>;

    expectTypeOf<Extract<WorkEvent, { eventType: 'work.item-created' }>>().toEqualTypeOf<
      EventEnvelope<
        'work.item-created',
        { readonly objective: string },
        EntityRef<'work-item', WorkItemId>
      >
    >();
    expectTypeOf<Extract<WorkEventData, { eventType: 'work.item-closed' }>>().toEqualTypeOf<
      EventData<'work.item-closed', { readonly reason: string }, EntityRef<'work-item', WorkItemId>>
    >();
  });

  it('supports an explicit two-generic event data input and factory call', () => {
    type Payload = { readonly objective: string };

    const input: EventDataInput<'work.item-created', Payload> = workDataInput({
      kind: 'work-item',
      id: 'work-1',
    } as const);

    const data = createEventData<'work.item-created', Payload>(input);

    expectTypeOf(data).toEqualTypeOf<EventData<'work.item-created', Payload, EntityRef>>();
    expect(data).not.toHaveProperty('recordedAt');
    expect(data).not.toHaveProperty('sequence');
    expect(data).not.toHaveProperty('globalPosition');
  });

  it('retains exact stream inference for an unannotated event data factory call', () => {
    type WorkItemId = Brand<string, 'WorkItemId'>;

    const workItemId = 'work-1' as WorkItemId;

    const data = createEventData(workDataInput({ kind: 'work-item', id: workItemId } as const));

    expectTypeOf(data.stream).toEqualTypeOf<EntityRef<'work-item', WorkItemId>>();
  });
});

describe('event data validation', () => {
  it('keeps domain payload separate from universal metadata', () => {
    const data = createEventData({
      eventId: 'evt-1',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr-1',
      causationId: 'cmd-1',
      actor: { kind: 'system', id: 'wake' },
      source: { kind: 'internal', id: 'wake' },
      stream: { kind: 'work-item', id: 'work-1' },
      payload: { objective: 'Ship the change' },
    });

    expect(data.schemaVersion).toBe(1);
    expect(data.payload).toEqual({ objective: 'Ship the change' });
    expect(data).not.toHaveProperty('github');
  });

  it.each([
    ['eventId', ''],
    ['eventType', ' '],
    ['occurredAt', 'not-a-timestamp'],
    ['correlationId', ''],
    ['causationId', ' '],
  ] as const)('rejects invalid %s metadata', (field, value) => {
    expect(() =>
      createEventData({
        eventId: 'evt-1',
        eventType: 'work.item-created',
        occurredAt: '2026-07-30T12:00:00.000Z',
        correlationId: 'corr-1',
        causationId: 'cmd-1',
        actor: { kind: 'system', id: 'wake' },
        source: { kind: 'internal', id: 'wake' },
        stream: { kind: 'work-item', id: 'work-1' },
        payload: {},
        [field]: value,
      }),
    ).toThrow();
  });

  it.each(['2026-07-31', 'July 31, 2026 12:00:00 UTC', '2026-07-31 12:00:00Z'])(
    'rejects a Date.parse-compatible non-offset-ISO occurredAt before construction: %s',
    (value) => {
      expect(() =>
        createEventData({
          ...workDataInput({ kind: 'work-item', id: 'work-1' } as const),
          occurredAt: value,
        }),
      ).toThrow(/occurred at.*offset.*iso/i);
    },
  );

  it.each(['actor', 'source'] as const)('rejects an empty %s id', (metadata) => {
    expect(() =>
      createEventData({
        eventId: 'evt-1',
        eventType: 'work.item-created',
        occurredAt: '2026-07-30T12:00:00.000Z',
        correlationId: 'corr-1',
        causationId: 'cmd-1',
        actor: { kind: 'system', id: 'wake' },
        source: { kind: 'internal', id: 'wake' },
        stream: { kind: 'work-item', id: 'work-1' },
        payload: {},
        [metadata]: {
          kind: metadata === 'actor' ? 'system' : 'internal',
          id: ' ',
        },
      }),
    ).toThrow(`${metadata} id must not be empty`);
  });
});

describe('entity relations', () => {
  const definition = {
    owner: 'work',
    name: 'work.related-to',
    fromKind: 'work-item',
    toKind: 'work-item',
  } satisfies RelationDefinition<'work.related-to'>;

  it('creates a registered relation with matching entity kinds', () => {
    expect(
      createRelation(definition, {
        relationId: 'rel-1',
        from: { kind: 'work-item', id: 'work-1' },
        to: { kind: 'work-item', id: 'work-2' },
        establishedByEventId: 'evt-1',
      }),
    ).toEqual({
      relationId: 'rel-1',
      definition,
      from: { kind: 'work-item', id: 'work-1' },
      to: { kind: 'work-item', id: 'work-2' },
      establishedByEventId: 'evt-1',
    });
  });

  it('rejects entity kinds that do not match the registered definition', () => {
    expect(() =>
      createRelation(definition, {
        relationId: 'rel-1',
        from: { kind: 'resource', id: 'resource-1' },
        to: { kind: 'work-item', id: 'work-2' },
        establishedByEventId: 'evt-1',
      }),
    ).toThrow('Relation work.related-to requires resource to be work-item');
  });
});
