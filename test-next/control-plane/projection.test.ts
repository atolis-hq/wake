import { expect, it } from 'vitest';
import { controlPlaneProjection } from '../../src-next/control-plane/index.js';
import { ControlEventType, controlPlaneStream } from '../../src-next/control-plane/index.js';
import { causationId, correlationId, eventId } from '../../src-next/kernel/index.js';

const event = (eventType: string, payload: unknown, globalPosition: number) => ({
  eventId: eventId(`event-${globalPosition}`),
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
  sequence: globalPosition,
  globalPosition,
});

it('projects a durable quota pause and clears it only after resume', () => {
  const paused = controlPlaneProjection.project(
    controlPlaneProjection.initial('global'),
    event(
      ControlEventType.DispatchPaused,
      { resumeAt: '2026-07-31T12:05:00.000Z', reason: 'quota' },
      1,
    ),
  );
  expect(paused).toEqual({ pausedUntil: '2026-07-31T12:05:00.000Z', reason: 'quota' });
  expect(
    controlPlaneProjection.project(
      paused,
      event(ControlEventType.DispatchResumed, { resumedAt: '2026-07-31T12:05:00.000Z' }, 2),
    ),
  ).toEqual({ pausedUntil: null });
});
