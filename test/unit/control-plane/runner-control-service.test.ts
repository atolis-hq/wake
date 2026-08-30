import { expect, it } from 'vitest';

import {
  ControlEventType,
  controlPlaneStream,
  createControlPlaneEventData,
  createRunnerControlService,
} from '../../../src/control-plane/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';

it('writes durable manual pause and explicit resume facts for a configured runner', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const service = createRunnerControlService({
    journal,
    clock,
    ids: new SequentialIds(),
    runners: new Set(['sonnet']),
  });

  await service.pause('sonnet', 'operator-42');
  await service.pause('sonnet', 'operator-42');
  await service.unpause('sonnet', 'operator-43');

  const events = await journal.readAll(0);
  expect(events.map((event) => event.event.eventType)).toEqual([
    ControlEventType.RunnerPaused,
    ControlEventType.RunnerResumed,
  ]);
  expect(events[0]?.event.payload).toMatchObject({
    runnerName: 'sonnet',
    cause: 'manual',
    reason: 'paused by operator',
  });
});

it('rejects an operator command for an unconfigured runner', async () => {
  const service = createRunnerControlService({
    journal: new InMemoryEventJournal(new FakeClock()),
    clock: new FakeClock(),
    ids: new SequentialIds(),
    runners: new Set(['sonnet']),
  });
  await expect(service.pause('unknown', 'operator-42')).rejects.toThrow(/Unknown runner/);
});

it('rejects unpause when the runner is not currently paused', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const service = createRunnerControlService({
    journal,
    clock: new FakeClock(),
    ids: new SequentialIds(),
    runners: new Set(['sonnet']),
  });

  await expect(service.unpause('sonnet', 'operator-43')).rejects.toThrow(/not paused/i);
  expect(await journal.readAll(0)).toHaveLength(0);
});

it('deduplicates an unpause after recreating the service from the same journal', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const input = { journal, clock, ids: new SequentialIds(), runners: new Set(['sonnet']) };
  const first = createRunnerControlService(input);
  await first.pause('sonnet', 'operator-42');
  await first.unpause('sonnet', 'operator-43');

  const second = createRunnerControlService({ ...input, ids: new SequentialIds() });
  await second.unpause('sonnet', 'operator-43');
  expect((await journal.readAll(0)).map((event) => event.event.eventType)).toEqual([
    ControlEventType.RunnerPaused,
    ControlEventType.RunnerResumed,
  ]);
});

it('rejects unpause after a quota pause has elapsed', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(controlPlaneStream(), 0, [
    createControlPlaneEventData({
      eventId: 'quota:control-plane.runner-paused',
      eventType: ControlEventType.RunnerPaused,
      occurredAt: clock.now().toISOString(),
      correlationId: 'quota',
      causationId: 'quota',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {
        runnerName: 'sonnet',
        cause: 'quota',
        reason: 'quota',
        resumeAt: new Date(clock.now().getTime() + 1_000).toISOString(),
      },
    }),
  ]);
  clock.advance(1_000);
  const service = createRunnerControlService({
    journal,
    clock,
    ids: new SequentialIds(),
    runners: new Set(['sonnet']),
  });
  await expect(service.unpause('sonnet', 'operator-43')).rejects.toThrow(/not paused/i);
  expect(await journal.readAll(0)).toHaveLength(1);
});

it('converges concurrent durable unpause commands from separate service instances', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const input = { journal, clock, ids: new SequentialIds(), runners: new Set(['sonnet']) };
  const first = createRunnerControlService(input);
  await first.pause('sonnet', 'pause');
  const second = createRunnerControlService({ ...input, ids: new SequentialIds() });
  await expect(
    Promise.all([first.unpause('sonnet', 'unpause'), second.unpause('sonnet', 'unpause')]),
  ).resolves.toEqual([undefined, undefined]);
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.event.eventType === ControlEventType.RunnerResumed,
    ),
  ).toHaveLength(1);
});
