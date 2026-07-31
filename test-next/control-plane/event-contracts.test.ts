import { expect, it } from 'vitest';
import {
  ControlEventType,
  controlPlaneStream,
  decodeControlEvent,
  selectControlEvent,
} from '../../src-next/control-plane/index.js';
import {
  causationId,
  correlationId,
  eventId,
  type EventEnvelope,
} from '../../src-next/kernel/index.js';

const envelope = (eventType: string, payload: unknown): EventEnvelope => ({
  eventId: eventId('event-1'),
  eventType,
  schemaVersion: 1 as const,
  occurredAt: '2026-07-31T12:00:00.000Z',
  recordedAt: '2026-07-31T12:00:00.000Z',
  correlationId: correlationId('correlation-1'),
  causationId: causationId('causation-1'),
  actor: { kind: 'system' as const, id: 'control-plane' },
  source: { kind: 'internal' as const, id: 'control-plane' },
  stream: controlPlaneStream(),
  payload,
  sequence: 1,
  globalPosition: 1,
});

it('decodes and selects strict dispatch pause/resume events', () => {
  const decoded = decodeControlEvent(
    envelope(ControlEventType.DispatchPaused, {
      resumeAt: '2026-07-31T12:05:00.000Z',
      reason: 'quota',
    }),
  );
  expect(decoded.eventType).toBe(ControlEventType.DispatchPaused);
  if (decoded.eventType === ControlEventType.DispatchPaused)
    expect(decoded.payload.reason).toBe('quota');
  expect(
    selectControlEvent(
      envelope(ControlEventType.DispatchResumed, { resumedAt: '2026-07-31T12:05:00.000Z' }),
    ),
  ).not.toBeNull();
});

it('throws for malformed owned events and ignores unrelated namespaces', () => {
  expect(() =>
    decodeControlEvent(
      envelope(ControlEventType.DispatchPaused, { resumeAt: 'not-a-date', reason: '' }),
    ),
  ).toThrow();
  expect(selectControlEvent(envelope('work.item-created', {}))).toBeNull();
});
