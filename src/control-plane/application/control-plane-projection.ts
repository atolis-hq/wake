import type { EventEnvelope, EventJournal, ProjectionDefinition } from '../../kernel/index.js';
import { ControlEventType, selectControlEvent, type ControlEvent } from '../contracts/events.js';
import { ControlStreamKind, controlPlaneStream } from '../contracts/streams.js';

export interface ControlPlaneView {
  readonly pausedUntil: string | null;
  readonly reason?: string;
  readonly runnerPauses: Readonly<
    Record<
      string,
      {
        readonly cause: Extract<
          ControlEvent['event'],
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

/**
 * Reads pause eligibility from the authoritative control stream for scheduling.
 * The folded view is cached only while the durable journal position is unchanged.
 */
export function createDurableRunnerIneligibility(
  journal: Pick<EventJournal, 'latestGlobalPosition' | 'readStream'>,
  now: () => string,
): () => Promise<ReadonlySet<string>> {
  let cached: { readonly position: number; readonly view: ControlPlaneView } | undefined;
  return async () => {
    const position = await journal.latestGlobalPosition();
    if (cached === undefined || cached.position !== position) {
      const view = (await journal.readStream(controlPlaneStream())).reduce(
        (previous, event) => controlPlaneProjection.project(previous, event),
        controlPlaneProjection.initial('global'),
      );
      cached = { position, view };
    }
    return ineligibleRunners(cached.view, now());
  };
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
    switch (event.event.eventType) {
      case ControlEventType.DispatchPaused:
        return {
          ...previous,
          pausedUntil: event.event.payload.resumeAt,
          reason: event.event.payload.reason,
        };
      case ControlEventType.DispatchResumed:
        return withoutDispatchPause(previous);
      case ControlEventType.RunnerPaused:
        return {
          ...previous,
          runnerPauses: {
            ...previous.runnerPauses,
            [event.event.payload.runnerName]: event.event.payload,
          },
        };
      case ControlEventType.RunnerResumed: {
        const { [event.event.payload.runnerName]: _, ...runnerPauses } = previous.runnerPauses;
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
