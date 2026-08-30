import {
  ControlEventType,
  ControlStreamKind,
  controlPlaneStream,
  createControlEventData,
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
    await journal.append(stream, (await journal.readStream(stream)).length, [
      createControlEventData(
        ControlEventType.RunnerPaused,
        {
          runnerName,
          cause: 'quota',
          reason: message,
          resumeAt: resolveRunnerQuotaResumeAt(message, occurredAt),
        },
        {
          commandId: ids.next('command'),
          correlationId: correlationId(`runner-quota:${runnerName}`),
          occurredAt,
          actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
        },
      ),
    ]);
  };
}
