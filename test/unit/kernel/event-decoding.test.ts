import { describe, expect, it } from 'vitest';
import { decodeEventEnvelope } from '../../../src/kernel/index.js';

const validEnvelope = {
  event: {
    eventId: 'event-1',
    eventType: 'work.item-created',
    schemaVersion: 1,
    occurredAt: '2026-07-31T12:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'causation-1',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: { objective: 'Ship it' },
  },
  recordedAt: '2026-07-31T12:00:01.000Z',
  stream: { kind: 'work-item', id: 'work-1' },
  sequence: 1,
  globalPosition: 1,
} as const;

describe('decodeEventEnvelope', () => {
  it('decodes every common field while preserving an unknown payload', () => {
    expect(decodeEventEnvelope(validEnvelope)).toEqual(validEnvelope);
  });

  it.each([
    ['eventId', ''],
    ['eventType', ' '],
    ['occurredAt', 'today'],
    ['correlationId', ''],
    ['causationId', ' '],
  ] as const)('rejects invalid %s', (field, value) => {
    expect(() =>
      decodeEventEnvelope({ ...validEnvelope, event: { ...validEnvelope.event, [field]: value } }),
    ).toThrow();
  });

  it.each([
    ['recordedAt', 'tomorrow'],
    ['sequence', 0],
    ['globalPosition', 1.5],
  ] as const)('rejects invalid recorded %s', (field, value) => {
    expect(() => decodeEventEnvelope({ ...validEnvelope, [field]: value })).toThrow();
  });

  it.each([
    ['actor', { kind: 'robot', id: 'test' }],
    ['source', { kind: 'remote', id: 'test' }],
  ] as const)('rejects an invalid %s contract', (field, value) => {
    expect(() =>
      decodeEventEnvelope({ ...validEnvelope, event: { ...validEnvelope.event, [field]: value } }),
    ).toThrow();
  });

  it('rejects an invalid stream contract', () => {
    expect(() =>
      decodeEventEnvelope({ ...validEnvelope, stream: { kind: '', id: 'work-1' } }),
    ).toThrow();
  });

  it('rejects unknown common fields', () => {
    expect(() => decodeEventEnvelope({ ...validEnvelope, surprise: true })).toThrow();
  });
});
