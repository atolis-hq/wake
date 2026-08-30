import { expect, it } from 'vitest';
import { createRunnerQuotaReporter } from '../../../src/bootstrap/runner-quota-reporter.js';
import { ControlStreamKind } from '../../../src/control-plane/index.js';
import { EventSourceKind } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';

it('preserves the generated command identity on durable runner quota pauses', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const report = createRunnerQuotaReporter(journal, clock, new SequentialIds());

  await report({ runnerName: 'codex', message: 'retry after 2026-08-30T13:00:00.000Z' });

  const event = (await journal.readAll(0))[0]!.event;
  expect(event.eventId).toBe('command-1:control-plane.runner-paused');
  expect(event.causationId).toBe('command-1');
  expect(event.source).toEqual({ kind: EventSourceKind.Internal, id: ControlStreamKind.Global });
});
