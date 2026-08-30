import {
  EventActorKind,
  correlationId,
  type Clock,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import {
  ControlEventType,
  createControlEventData,
  selectControlEvent,
} from '../contracts/events.js';
import { controlPlaneStream } from '../contracts/streams.js';

export interface ControlPlaneService {
  pause(idempotencyKey: string): Promise<void>;
  resume(idempotencyKey: string): Promise<void>;
  isPaused(): Promise<boolean>;
}

export function createControlPlaneService(input: {
  readonly journal: EventJournal;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}): ControlPlaneService {
  // isPaused() is checked many times per pipeline run, so memoize by
  // journal position to skip the read entirely when nothing has moved.
  let cached: { readonly position: number; readonly paused: boolean } | undefined;
  return {
    pause: (key) => change(input, key, 'pause'),
    resume: (key) => change(input, key, 'resume'),
    async isPaused() {
      const position = await input.journal.latestGlobalPosition();
      if (cached !== undefined && cached.position === position) return cached.paused;
      const paused = await currentIsPaused(input.journal);
      cached = { position, paused };
      return paused;
    },
  };
}

async function currentIsPaused(journal: EventJournal): Promise<boolean> {
  return isPausedIn(await journal.readStream(controlPlaneStream()));
}

function isPausedIn(events: Awaited<ReturnType<EventJournal['readStream']>>): boolean {
  let paused = false;
  for (const envelope of events) {
    const event = selectControlEvent(envelope);
    if (event?.eventType === ControlEventType.DispatchPaused) paused = true;
    if (event?.eventType === ControlEventType.DispatchResumed) paused = false;
  }
  return paused;
}

async function change(
  input: Parameters<typeof createControlPlaneService>[0],
  idempotencyKey: string,
  operation: 'pause' | 'resume',
): Promise<void> {
  const stream = controlPlaneStream();
  const events = await input.journal.readStream(stream);
  const eventType =
    operation === 'pause' ? ControlEventType.DispatchPaused : ControlEventType.DispatchResumed;
  const correlation = correlationId(`control:${operation}:${idempotencyKey}`);
  if (events.some((event) => event.eventType === eventType && event.correlationId === correlation))
    return;
  const currentlyPaused = isPausedIn(events);
  if ((operation === 'pause' && currentlyPaused) || (operation === 'resume' && !currentlyPaused))
    return;
  const occurredAt = input.clock.now().toISOString();
  const context = {
    commandId: input.ids.next('command'),
    correlationId: correlation,
    occurredAt,
    actor: { kind: EventActorKind.Operator, id: 'web' },
  };
  const event =
    operation === 'pause'
      ? createControlEventData(
          ControlEventType.DispatchPaused,
          { resumeAt: '9999-12-31T23:59:59.999Z', reason: 'paused by operator' },
          context,
        )
      : createControlEventData(
          ControlEventType.DispatchResumed,
          { resumedAt: occurredAt },
          context,
        );
  await input.journal.append(stream, events.length, [event]);
}
