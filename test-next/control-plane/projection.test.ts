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
  expect(paused).toEqual({
    pausedUntil: '2026-07-31T12:05:00.000Z',
    reason: 'quota',
    runnerPauses: {},
  });
  expect(
    controlPlaneProjection.project(
      paused,
      event(ControlEventType.DispatchResumed, { resumedAt: '2026-07-31T12:05:00.000Z' }, 2),
    ),
  ).toEqual({ pausedUntil: null, runnerPauses: {} });
});

it('keeps manual and unexpired quota runner pauses in the durable projection', () => {
  const quotaPaused = controlPlaneProjection.project(
    controlPlaneProjection.initial('global'),
    event(
      'control-plane.runner-paused',
      {
        runnerName: 'sonnet',
        cause: 'quota',
        reason: 'provider quota exceeded',
        resumeAt: '2026-08-01T12:30:00.000Z',
      },
      1,
    ),
  );
  const manuallyPaused = controlPlaneProjection.project(
    quotaPaused,
    event(
      'control-plane.runner-paused',
      { runnerName: 'codex-mini', cause: 'manual', reason: 'operator maintenance' },
      2,
    ),
  );
  expect(manuallyPaused).toMatchObject({
    runnerPauses: {
      sonnet: { cause: 'quota', resumeAt: '2026-08-01T12:30:00.000Z' },
      'codex-mini': { cause: 'manual' },
    },
  });
});
