import {
  EventActorKind,
  correlationId,
  type Clock,
  type EventJournal,
  type IdGenerator,
} from '../../kernel/index.js';
import { ControlEventType, createControlEventDraft } from '../contracts/events.js';
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
  const occurredAt = input.clock.now().toISOString();
  const context = {
    commandId: input.ids.next('command'),
    correlationId: correlationId(`runner:${runnerName}:${idempotencyKey}`),
    occurredAt,
    actor: { kind: EventActorKind.Operator, id: 'web' },
  };
  const event =
    operation === 'pause'
      ? createControlEventDraft(
          ControlEventType.RunnerPaused,
          { runnerName, cause: 'manual', reason: 'paused by operator' },
          context,
        )
      : createControlEventDraft(
          ControlEventType.RunnerResumed,
          { runnerName, resumedAt: occurredAt },
          context,
        );
  await input.journal.append(stream, (await input.journal.readStream(stream)).length, [event]);
}
