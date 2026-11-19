import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRunnerQuotaReporter } from '../../../src/bootstrap/runner-quota-reporter.js';
import {
  ControlEventType,
  RunnerPauseCause,
  createDurableRunnerIneligibility,
  createRunnerControlService,
} from '../../../src/control-plane/index.js';
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

it('retains authentication ineligibility across restart and elapsed time until operator resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-runner-auth-'));
  const clock = new FakeClock();
  await createRunnerQuotaReporter(
    new FileEventJournal(root, clock),
    clock,
    new SequentialIds(),
    RunnerPauseCause.Authentication,
  )({ runnerName: 'sonnet' });
  clock.advance(7 * 24 * 60 * 60_000);
  const reopened = new FileEventJournal(root, clock);
  const eligibility = createDurableRunnerIneligibility(reopened, () => clock.now().toISOString());
  expect(await eligibility()).toEqual(new Set(['sonnet']));
  await createRunnerControlService({
    journal: reopened,
    clock,
    ids: new SequentialIds(),
    runners: new Set(['sonnet']),
  }).unpause('sonnet', 'restored');
  expect(await eligibility()).toEqual(new Set());
});
