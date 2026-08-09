import {
  EventActorKind,
  correlationId,
  type Clock,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import {
  ControlEventType,
  createControlEventDraft,
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
  return {
    pause: (key) => change(input, key, 'pause'),
    resume: (key) => change(input, key, 'resume'),
    async isPaused() {
      let paused = false;
      for (const envelope of await input.journal.readStream(controlPlaneStream())) {
        const event = selectControlEvent(envelope);
        if (event?.eventType === ControlEventType.DispatchPaused) paused = true;
        if (event?.eventType === ControlEventType.DispatchResumed) paused = false;
      }
      return paused;
    },
  };
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
  const currentlyPaused = await createControlPlaneService(input).isPaused();
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
      ? createControlEventDraft(
          ControlEventType.DispatchPaused,
          { resumeAt: '9999-12-31T23:59:59.999Z', reason: 'paused by operator' },
          context,
        )
      : createControlEventDraft(
          ControlEventType.DispatchResumed,
          { resumedAt: occurredAt },
          context,
        );
  await input.journal.append(stream, events.length, [event]);
}
