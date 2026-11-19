import {
  EventActorKind,
  EventSourceKind,
  correlationId,
  type EventJournal,
} from '@atolis-hq/eventing';
import { RunnerAuthenticationMessage } from '../activities/index.js';
import {
  ControlEventType,
  ControlStreamKind,
  RunnerPauseCause,
  controlPlaneStream,
  createControlPlaneEventData,
  resolveRunnerQuotaResumeAt,
} from '../control-plane/index.js';
import { type Clock, type IdGenerator } from '../kernel/index.js';

export function createRunnerQuotaReporter(
  journal: EventJournal,
  clock: Clock,
  ids: IdGenerator,
  cause:
    typeof RunnerPauseCause.Quota | typeof RunnerPauseCause.Authentication = RunnerPauseCause.Quota,
) {
  return async ({
    runnerName,
    message,
  }: {
    readonly runnerName: string;
    readonly message?: string;
  }) => {
    const quotaMessage = message ?? 'runner reported quota exhaustion';
    const stream = controlPlaneStream();
    const occurredAt = clock.now().toISOString();
    const commandId = ids.next('command');
    await journal.appendToStream(stream, (await journal.readStream(stream)).length, [
      createControlPlaneEventData({
        eventId: `${commandId}:${ControlEventType.RunnerPaused}`,
        eventType: ControlEventType.RunnerPaused,
        occurredAt,
        correlationId: correlationId(`runner-${cause}:${runnerName}`),
        causationId: commandId,
        actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
        source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
        payload: {
          runnerName,
          cause,
          reason:
            cause === RunnerPauseCause.Authentication ? RunnerAuthenticationMessage : quotaMessage,
          ...(cause === RunnerPauseCause.Quota
            ? { resumeAt: resolveRunnerQuotaResumeAt(quotaMessage, occurredAt) }
            : {}),
        },
      }),
    ]);
  };
}
