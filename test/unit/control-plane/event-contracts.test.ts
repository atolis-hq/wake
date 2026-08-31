import { causationId, correlationId, eventId, type EventEnvelope } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import {
  ControlEventType,
  controlPlaneStream,
  decodeControlEvent,
  selectControlEvent,
} from '../../../src/control-plane/index.js';

const envelope = (eventType: string, payload: unknown): EventEnvelope => ({
  event: {
    eventId: eventId('event-1'),
    eventType,
    schemaVersion: 1 as const,
    occurredAt: '2026-07-31T12:00:00.000Z',
    correlationId: correlationId('correlation-1'),
    causationId: causationId('causation-1'),
    actor: { kind: 'system' as const, id: 'control-plane' },
    source: { kind: 'internal' as const, id: 'control-plane' },
    payload,
  },
  recordedAt: '2026-07-31T12:00:00.000Z',
  stream: controlPlaneStream(),
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
  expect(decoded.event.eventType).toBe(ControlEventType.DispatchPaused);
  if (decoded.event.eventType === ControlEventType.DispatchPaused)
    expect(decoded.event.payload.reason).toBe('quota');
  expect(
    selectControlEvent(
      envelope(ControlEventType.DispatchResumed, { resumedAt: '2026-07-31T12:05:00.000Z' }),
    ),
  ).not.toBeNull();
});

it('decodes strict runner quota pause and manual resume events', () => {
  const paused = decodeControlEvent(
    envelope('control-plane.runner-paused', {
      runnerName: 'sonnet',
      cause: 'quota',
      reason: 'provider quota exceeded',
      resumeAt: '2026-08-01T12:30:00.000Z',
    }),
  );
  expect(paused.event.eventType).toBe('control-plane.runner-paused');
  const resumed = decodeControlEvent(
    envelope('control-plane.runner-resumed', {
      runnerName: 'sonnet',
      resumedAt: '2026-08-01T12:05:00.000Z',
    }),
  );
  expect(resumed.event.eventType).toBe('control-plane.runner-resumed');
  expect(() =>
    decodeControlEvent(
      envelope('control-plane.runner-paused', {
        runnerName: 'sonnet',
        cause: 'quota',
        reason: 'provider quota exceeded',
      }),
    ),
  ).toThrow();
});

it('throws for malformed owned events and ignores unrelated namespaces', () => {
  expect(() =>
    decodeControlEvent(
      envelope(ControlEventType.DispatchPaused, { resumeAt: 'not-a-date', reason: '' }),
    ),
  ).toThrow();
  expect(selectControlEvent(envelope('work.item-created', {}))).toBeNull();
});
