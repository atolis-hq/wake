import type { EventEnvelope, ProjectionDefinition } from '../../kernel/index.js';
import { ControlEventType, selectControlEvent, type ControlEvent } from '../contracts/events.js';
import { ControlStreamKind } from '../contracts/streams.js';

export interface ControlPlaneView {
  readonly pausedUntil: string | null;
  readonly reason?: string;
  readonly runnerPauses: Readonly<
    Record<
      string,
      {
        readonly cause: Extract<
          ControlEvent,
          { readonly eventType: typeof ControlEventType.RunnerPaused }
        >['payload']['cause'];
        readonly reason: string;
        readonly resumeAt?: string | undefined;
      }
    >
  >;
}

export function ineligibleRunners(view: ControlPlaneView, now: string): ReadonlySet<string> {
  const current = Date.parse(now);
  return new Set(
    Object.entries(view.runnerPauses)
      .filter(([, pause]) => pause.resumeAt === undefined || Date.parse(pause.resumeAt) > current)
      .map(([runnerName]) => runnerName),
  );
}

export const controlPlaneProjection: ProjectionDefinition<ControlPlaneView> = {
  name: ControlStreamKind.Global,
  select(event: EventEnvelope) {
    return selectControlEvent(event) === null ? null : { key: 'global' };
  },
  initial: () => ({ pausedUntil: null, runnerPauses: {} }),
  project(previous, envelope) {
    const event = selectControlEvent(envelope);
    if (event === null) return previous;
    switch (event.eventType) {
      case ControlEventType.DispatchPaused:
        return { ...previous, pausedUntil: event.payload.resumeAt, reason: event.payload.reason };
      case ControlEventType.DispatchResumed:
        return withoutDispatchPause(previous);
      case ControlEventType.RunnerPaused:
        return {
          ...previous,
          runnerPauses: { ...previous.runnerPauses, [event.payload.runnerName]: event.payload },
        };
      case ControlEventType.RunnerResumed: {
        const { [event.payload.runnerName]: _, ...runnerPauses } = previous.runnerPauses;
        return { ...previous, runnerPauses };
      }
    }
  },
};

function withoutDispatchPause(previous: ControlPlaneView): ControlPlaneView {
  const { reason: _, ...rest } = previous;
  return { ...rest, pausedUntil: null };
}

export const controlPlaneProjectionDefinitions: readonly ProjectionDefinition[] = [
  controlPlaneProjection,
];
