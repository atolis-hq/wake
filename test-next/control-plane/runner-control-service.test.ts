import { expect, it } from 'vitest';
import {
  createRunnerControlService,
  ControlEventType,
} from '../../src-next/control-plane/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { FakeClock, SequentialIds } from '../e2e/support/world.js';

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
  expect(events.map((event) => event.eventType)).toEqual([
    ControlEventType.RunnerPaused,
    ControlEventType.RunnerResumed,
  ]);
  expect(events[0]?.payload).toMatchObject({
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
