import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ControlEventType, createRunnerControlService } from '../../../src/control-plane/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';

it('deduplicates an unpause after a filesystem-backed service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-runner-control-'));
  const clock = new FakeClock();
  const first = createRunnerControlService({
    journal: new FileEventJournal(root, clock),
    clock,
    ids: new SequentialIds(),
    runners: new Set(['sonnet']),
  });
  await first.pause('sonnet', 'operator-42');
  await first.unpause('sonnet', 'operator-43');

  const reopened = new FileEventJournal(root, clock);
  const restarted = createRunnerControlService({
    journal: reopened,
    clock,
    ids: new SequentialIds(),
    runners: new Set(['sonnet']),
  });
  await restarted.unpause('sonnet', 'operator-43');

  expect((await reopened.readAll(0)).map((event) => event.event.eventType)).toEqual([
    ControlEventType.RunnerPaused,
    ControlEventType.RunnerResumed,
  ]);
});
