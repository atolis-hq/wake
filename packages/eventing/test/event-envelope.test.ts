import {
  createEventData,
  type EventData,
  type EventDataInput,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
  type StreamRef,
} from '@atolis-hq/eventing';
import { describe, expect, expectTypeOf, it } from 'vitest';

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

interface EntityRef<Kind extends string = string, Id extends string = string> {
  readonly kind: Kind;
  readonly id: Id;
}

function workDataInput() {
  return {
    eventId: 'evt-1',
    eventType: 'work.item-created',
    occurredAt: '2026-07-30T12:00:00.000Z',
    correlationId: 'corr-1',
    causationId: 'cmd-1',
    actor: { kind: 'system', id: 'wake' },
    source: { kind: 'internal', id: 'wake' },
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

  it('maps each event type to its exact payload and envelope stream', () => {
    type WorkItemId = Brand<string, 'WorkItemId'>;

    type WorkStream = StreamRef<'work-item', WorkItemId>;

    interface WorkEventPayloads {
      readonly 'work.item-created': { readonly objective: string };
      readonly 'work.item-closed': { readonly reason: string };
    }

    type WorkEvent = EventUnion<WorkEventPayloads, WorkStream>;

    type WorkEventData = EventDataUnion<WorkEventPayloads>;

    expectTypeOf<WorkEvent>().toEqualTypeOf<
      EventEnvelope<EventDataUnion<WorkEventPayloads>, StreamRef<'work-item', WorkItemId>>
    >();
    expectTypeOf<Extract<WorkEventData, { eventType: 'work.item-closed' }>>().toEqualTypeOf<
      EventData<'work.item-closed', { readonly reason: string }>
    >();
  });

  it('supports an explicit two-generic event data input and factory call', () => {
    type Payload = { readonly objective: string };

    const input: EventDataInput<'work.item-created', Payload> = workDataInput();

    const data = createEventData<'work.item-created', Payload>(input);

    expectTypeOf(data).toEqualTypeOf<EventData<'work.item-created', Payload>>();
    expect(data).not.toHaveProperty('recordedAt');
    expect(data).not.toHaveProperty('sequence');
    expect(data).not.toHaveProperty('globalPosition');
  });

  it('keeps stream identity outside unannotated event data', () => {
    type WorkItemId = Brand<string, 'WorkItemId'>;

    const workItemId = 'work-1' as WorkItemId;

    const data = createEventData(workDataInput());
    const envelope: EventEnvelope<typeof data, StreamRef<'work-item', WorkItemId>> = {
      event: data,
      stream: { kind: 'work-item', id: workItemId },
      recordedAt: '2026-07-30T12:00:01.000Z',
      sequence: 1,
      globalPosition: 1,
    };

    expectTypeOf(envelope.stream).toEqualTypeOf<EntityRef<'work-item', WorkItemId>>();
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
          ...workDataInput(),
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
        payload: {},
        [metadata]: {
          kind: metadata === 'actor' ? 'system' : 'internal',
          id: ' ',
        },
      }),
    ).toThrow(`${metadata} id must not be empty`);
  });
});
