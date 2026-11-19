import { correlationId, EventActorKind, EventSourceKind } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { RunnerAuthenticationMessage } from '../../../src/activities/index.js';
import { createRunnerQuotaReporter } from '../../../src/bootstrap/runner-quota-reporter.js';
import {
  ControlEventType,
  ControlStreamKind,
  createControlPlaneEventData,
  RunnerPauseCause,
} from '../../../src/control-plane/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';

it('preserves the generated command identity on durable runner quota pauses', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const report = createRunnerQuotaReporter(journal, clock, new SequentialIds());

  await report({ runnerName: 'codex', message: 'retry after 2026-08-30T13:00:00.000Z' });

  expect((await journal.readAll(0))[0]!.event).toEqual(
    createControlPlaneEventData({
      eventId: 'command-1:control-plane.runner-paused',
      eventType: ControlEventType.RunnerPaused,
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: correlationId('runner-quota:codex'),
      causationId: 'command-1' as never,
      actor: { kind: EventActorKind.System, id: ControlStreamKind.Global },
      source: { kind: EventSourceKind.Internal, id: ControlStreamKind.Global },
      payload: {
        runnerName: 'codex',
        cause: 'quota',
        reason: 'retry after 2026-08-30T13:00:00.000Z',
        resumeAt: '2026-07-30T12:30:00.000Z',
      },
    }),
  );
});

it('records a sanitized authentication pause with no automatic deadline', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  await createRunnerQuotaReporter(
    journal,
    clock,
    new SequentialIds(),
    RunnerPauseCause.Authentication,
  )({ runnerName: 'claude', message: 'invalid api key: SECRET' });
  expect((await journal.readAll(0))[0]!.event.payload).toEqual({
    runnerName: 'claude',
    cause: RunnerPauseCause.Authentication,
    reason: RunnerAuthenticationMessage,
  });
});
