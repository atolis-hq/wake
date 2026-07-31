import type { EventEnvelope, ProjectionDefinition } from '../../kernel/index.js';
import { ControlEventType, selectControlEvent } from '../contracts/events.js';
import { ControlStreamKind } from '../contracts/streams.js';

export interface ControlPlaneView {
  readonly pausedUntil: string | null;
  readonly reason?: string;
}

export const controlPlaneProjection: ProjectionDefinition<ControlPlaneView> = {
  name: ControlStreamKind.Global,
  select(event: EventEnvelope) {
    return selectControlEvent(event) === null ? null : { key: 'global' };
  },
  initial: () => ({ pausedUntil: null }),
  project(previous, envelope) {
    const event = selectControlEvent(envelope);
    if (event === null) return previous;
    switch (event.eventType) {
      case ControlEventType.DispatchPaused:
        return { pausedUntil: event.payload.resumeAt, reason: event.payload.reason };
      case ControlEventType.DispatchResumed:
        return { pausedUntil: null };
    }
  },
};

export const controlPlaneProjectionDefinitions: readonly ProjectionDefinition[] = [
  controlPlaneProjection,
];
