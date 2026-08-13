import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createEventDraft,
  createRelation,
  type Brand,
  type EntityRef,
  type EventDraft,
  type EventDraftInput,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
  type RelationDefinition,
} from '../../../src/kernel/index.js';

function workDraftInput<Stream extends EntityRef>(stream: Stream) {
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

    type WorkEventDraft = EventDraftUnion<WorkEventPayloads, WorkStream>;

    expectTypeOf<Extract<WorkEvent, { eventType: 'work.item-created' }>>().toEqualTypeOf<
      EventEnvelope<
        'work.item-created',
        { readonly objective: string },
        EntityRef<'work-item', WorkItemId>
      >
    >();
    expectTypeOf<Extract<WorkEventDraft, { eventType: 'work.item-closed' }>>().toEqualTypeOf<
      EventDraft<
        'work.item-closed',
        { readonly reason: string },
        EntityRef<'work-item', WorkItemId>
      >
    >();
  });

  it('supports an explicit two-generic draft input and factory call', () => {
    type Payload = { readonly objective: string };

    const input: EventDraftInput<'work.item-created', Payload> = workDraftInput({
      kind: 'work-item',
      id: 'work-1',
    } as const);

    const draft = createEventDraft<'work.item-created', Payload>(input);

    expectTypeOf(draft).toEqualTypeOf<EventDraft<'work.item-created', Payload, EntityRef>>();
  });

  it('retains exact stream inference for an unannotated draft factory call', () => {
    type WorkItemId = Brand<string, 'WorkItemId'>;

    const workItemId = 'work-1' as WorkItemId;

    const draft = createEventDraft(workDraftInput({ kind: 'work-item', id: workItemId } as const));

    expectTypeOf(draft.stream).toEqualTypeOf<EntityRef<'work-item', WorkItemId>>();
  });
});

describe('event draft validation', () => {
  it('keeps domain payload separate from universal metadata', () => {
    const draft = createEventDraft({
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

    expect(draft.schemaVersion).toBe(1);
    expect(draft.payload).toEqual({ objective: 'Ship the change' });
    expect(draft).not.toHaveProperty('github');
  });

  it.each([
    ['eventId', ''],
    ['eventType', ' '],
    ['occurredAt', 'not-a-timestamp'],
    ['correlationId', ''],
    ['causationId', ' '],
  ] as const)('rejects invalid %s metadata', (field, value) => {
    expect(() =>
      createEventDraft({
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
        createEventDraft({
          ...workDraftInput({ kind: 'work-item', id: 'work-1' } as const),
          occurredAt: value,
        }),
      ).toThrow(/occurred at.*offset.*iso/i);
    },
  );

  it.each(['actor', 'source'] as const)('rejects an empty %s id', (metadata) => {
    expect(() =>
      createEventDraft({
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
