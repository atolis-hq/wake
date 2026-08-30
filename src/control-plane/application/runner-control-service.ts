import {
  EventActorKind,
  WrongExpectedSequenceError,
  correlationId,
  type Clock,
  type EventEnvelope,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import {
  ControlEventType,
  createControlEventData,
  selectControlEvent,
} from '../contracts/events.js';
import { controlPlaneStream } from '../contracts/streams.js';

export interface RunnerControlService {
  pause(runnerName: string, idempotencyKey: string): Promise<void>;
  unpause(runnerName: string, idempotencyKey: string): Promise<void>;
}

export function createRunnerControlService(input: {
  readonly journal: EventJournal;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly runners: ReadonlySet<string>;
}): RunnerControlService {
  const commands = new Map<string, Promise<void>>();
  const once = (key: string, operation: () => Promise<void>) => {
    const existing = commands.get(key);
    if (existing !== undefined) return existing;
    const pending = operation().finally(() => commands.set(key, pending));
    commands.set(key, pending);
    return pending;
  };
  return {
    pause: (runnerName, idempotencyKey) =>
      once(`pause:${runnerName}:${idempotencyKey}`, () =>
        append(input, runnerName, idempotencyKey, 'pause'),
      ),
    unpause: (runnerName, idempotencyKey) =>
      once(`unpause:${runnerName}:${idempotencyKey}`, () =>
        append(input, runnerName, idempotencyKey, 'unpause'),
      ),
  };
}

async function append(
  input: Parameters<typeof createRunnerControlService>[0],
  runnerName: string,
  idempotencyKey: string,
  operation: 'pause' | 'unpause',
): Promise<void> {
  if (!input.runners.has(runnerName)) throw new Error(`Unknown runner: ${runnerName}`);
  const stream = controlPlaneStream();
  const events = await input.journal.readStream(stream);
  const expectedType =
    operation === 'pause' ? ControlEventType.RunnerPaused : ControlEventType.RunnerResumed;
  const correlation = correlationId(`runner:${runnerName}:${idempotencyKey}`);
  if (
    events.some((event) => event.eventType === expectedType && event.correlationId === correlation)
  )
    return;
  if (
    operation === 'unpause' &&
    !runnerIsPaused(events, runnerName, input.clock.now().toISOString())
  )
    throw new Error(`Runner ${runnerName} is not paused`);
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
          ControlEventType.RunnerPaused,
          { runnerName, cause: 'manual', reason: 'paused by operator' },
          context,
        )
      : createControlEventData(
          ControlEventType.RunnerResumed,
          { runnerName, resumedAt: occurredAt },
          context,
        );
  try {
    await input.journal.append(stream, events.length, [event]);
  } catch (error) {
    if (!(error instanceof WrongExpectedSequenceError)) throw error;
    const latest = await input.journal.readStream(stream);
    if (
      latest.some(
        (entry) => entry.eventType === expectedType && entry.correlationId === correlation,
      )
    )
      return;
    throw error;
  }
}

function runnerIsPaused(
  events: readonly EventEnvelope[],
  runnerName: string,
  now: string,
): boolean {
  let pause: { readonly resumeAt?: string } | undefined;
  for (const envelope of events) {
    const event = selectControlEvent(envelope);
    if (
      event?.eventType === ControlEventType.RunnerPaused &&
      event.payload.runnerName === runnerName
    )
      pause = event.payload.resumeAt === undefined ? {} : { resumeAt: event.payload.resumeAt };
    if (
      event?.eventType === ControlEventType.RunnerResumed &&
      event.payload.runnerName === runnerName
    )
      pause = undefined;
  }
  return (
    pause !== undefined &&
    (pause.resumeAt === undefined || Date.parse(pause.resumeAt) > Date.parse(now))
  );
}
