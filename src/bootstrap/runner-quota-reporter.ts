import {
  ControlEventType,
  ControlStreamKind,
  controlPlaneStream,
  createControlPlaneEventData,
  resolveRunnerQuotaResumeAt,
} from '../control-plane/index.js';
import {
  EventActorKind,
  EventSourceKind,
  correlationId,
  type Clock,
  type EventJournal,
  type IdGenerator,
} from '../kernel/index.js';

export function createRunnerQuotaReporter(journal: EventJournal, clock: Clock, ids: IdGenerator) {
  return async ({
    runnerName,
    message,
  }: {
    readonly runnerName: string;
    readonly message: string;
  }) => {
    const stream = controlPlaneStream();
    const occurredAt = clock.now().toISOString();
    const commandId = ids.next('command');
    await journal.appendToStream(stream, (await journal.readStream(stream)).length, [
      createControlPlaneEventData({
        eventId: `${commandId}:${ControlEventType.RunnerPaused}`,
        eventType: ControlEventType.RunnerPaused,
        occurredAt,
        correlationId: correlationId(`runner-quota:${runnerName}`),
        causationId: commandId,
        actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
        source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
        payload: {
          runnerName,
          cause: 'quota',
          reason: message,
          resumeAt: resolveRunnerQuotaResumeAt(message, occurredAt),
        },
      }),
    ]);
  };
}
