import { describe, expect, it } from 'vitest';
import { decodeEventEnvelope } from '../../src-next/kernel/index.js';

const validEnvelope = {
  eventId: 'event-1',
  eventType: 'work.item-created',
  schemaVersion: 1,
  occurredAt: '2026-07-31T12:00:00.000Z',
  recordedAt: '2026-07-31T12:00:01.000Z',
  correlationId: 'correlation-1',
  causationId: 'causation-1',
  actor: { kind: 'system', id: 'test' },
  source: { kind: 'internal', id: 'test' },
  stream: { kind: 'work-item', id: 'work-1' },
  sequence: 1,
  globalPosition: 1,
  payload: { objective: 'Ship it' },
} as const;

describe('decodeEventEnvelope', () => {
  it('decodes every common field while preserving an unknown payload', () => {
    expect(decodeEventEnvelope(validEnvelope)).toEqual(validEnvelope);
  });

  it.each([
    ['eventId', ''],
    ['eventType', ' '],
    ['occurredAt', 'today'],
    ['recordedAt', 'tomorrow'],
    ['correlationId', ''],
    ['causationId', ' '],
    ['sequence', 0],
    ['globalPosition', 1.5],
  ] as const)('rejects invalid %s', (field, value) => {
    expect(() => decodeEventEnvelope({ ...validEnvelope, [field]: value })).toThrow();
  });

  it.each([
    ['actor', { kind: 'robot', id: 'test' }],
    ['source', { kind: 'remote', id: 'test' }],
    ['stream', { kind: '', id: 'work-1' }],
  ] as const)('rejects an invalid %s contract', (field, value) => {
    expect(() => decodeEventEnvelope({ ...validEnvelope, [field]: value })).toThrow();
  });

  it('rejects unknown common fields', () => {
    expect(() => decodeEventEnvelope({ ...validEnvelope, surprise: true })).toThrow();
  });
});
