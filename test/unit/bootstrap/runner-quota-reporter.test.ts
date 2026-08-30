import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createRunnerQuotaReporter } from '../../../src/bootstrap/runner-quota-reporter.js';
import {
  ControlEventType,
  ControlStreamKind,
  createControlPlaneEventData,
} from '../../../src/control-plane/index.js';
import { correlationId, EventActorKind, EventSourceKind } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
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

it('delegates runner quota fact construction to Control Plane', async () => {
  const source = await readFile(
    new URL('../../../src/bootstrap/runner-quota-reporter.ts', import.meta.url),
    'utf8',
  );

  expect(source).toContain('createControlPlaneEventData');
  expect(source).not.toMatch(/\bcreateEventData\b/);
});
