import {
  ControlEventType,
  ControlStreamKind,
  controlPlaneStream,
  createControlPlaneEventData,
  resolveRunnerQuotaResumeAt,
} from '../control-plane/index.js';
import {
  EventActorKind,
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
    await journal.appendToStream(stream, (await journal.readStream(stream)).length, [
      createControlPlaneEventData({
        eventId: `${ids.next('command')}:${ControlEventType.RunnerPaused}`,
        eventType: ControlEventType.RunnerPaused,
        occurredAt,
        correlationId: correlationId(`runner-quota:${runnerName}`),
        causationId: `runner-quota:${runnerName}`,
        actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
        source: { kind: 'internal', id: ControlStreamKind.Global },
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
