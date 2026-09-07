import {
  EventActorKind,
  EventSourceKind,
  correlationId,
  type EventJournal,
} from '@atolis-hq/eventing';
import { type Clock, type IdGenerator } from '../../kernel/index.js';
import { createControlPlaneEventData } from '../contracts/event-factory.js';
import { ControlEventType, selectControlEvent } from '../contracts/events.js';
import { ControlStreamKind, controlPlaneStream } from '../contracts/streams.js';

export interface ControlPlaneService {
  pauseDispatch(idempotencyKey: string): Promise<void>;
  resumeDispatch(idempotencyKey: string): Promise<void>;
  isDispatchPaused(): Promise<boolean>;
}

export function createControlPlaneService(input: {
  readonly journal: EventJournal;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}): ControlPlaneService {
  // isDispatchPaused() is checked many times per pipeline run, so memoize by
  // journal position to skip the read entirely when nothing has moved.
  let cached: { readonly position: number; readonly paused: boolean } | undefined;
  return {
    pauseDispatch: (key) => change(input, key, 'pause-dispatch'),
    resumeDispatch: (key) => change(input, key, 'resume-dispatch'),
    async isDispatchPaused() {
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
    if (event?.event.eventType === ControlEventType.DispatchPaused) paused = true;
    if (event?.event.eventType === ControlEventType.DispatchResumed) paused = false;
  }
  return paused;
}

async function change(
  input: Parameters<typeof createControlPlaneService>[0],
  idempotencyKey: string,
  operation: 'pause-dispatch' | 'resume-dispatch',
): Promise<void> {
  const stream = controlPlaneStream();
  const events = await input.journal.readStream(stream);
  const eventType =
    operation === 'pause-dispatch'
      ? ControlEventType.DispatchPaused
      : ControlEventType.DispatchResumed;
  const correlation = correlationId(`control:${operation}:${idempotencyKey}`);
  if (
    events.some(
      (event) => event.event.eventType === eventType && event.event.correlationId === correlation,
    )
  )
    return;
  const currentlyPaused = isPausedIn(events);
  if (
    (operation === 'pause-dispatch' && currentlyPaused) ||
    (operation === 'resume-dispatch' && !currentlyPaused)
  )
    return;
  const occurredAt = input.clock.now().toISOString();
  const context = {
    commandId: input.ids.next('command'),
    correlationId: correlation,
    occurredAt,
    actor: { kind: EventActorKind.Operator, id: 'web' },
  };
  const event =
    operation === 'pause-dispatch'
      ? createControlPlaneEventData({
          eventId: `${context.commandId}:${ControlEventType.DispatchPaused}`,
          eventType: ControlEventType.DispatchPaused,
          occurredAt: context.occurredAt,
          correlationId: context.correlationId,
          causationId: context.commandId,
          actor: context.actor,
          source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
          payload: { resumeAt: '9999-12-31T23:59:59.999Z', reason: 'paused by operator' },
        })
      : createControlPlaneEventData({
          eventId: `${context.commandId}:${ControlEventType.DispatchResumed}`,
          eventType: ControlEventType.DispatchResumed,
          occurredAt: context.occurredAt,
          correlationId: context.correlationId,
          causationId: context.commandId,
          actor: context.actor,
          source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
          payload: { resumedAt: occurredAt },
        });
  await input.journal.appendToStream(stream, events.length, [event]);
}
