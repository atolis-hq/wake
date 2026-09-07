import { expect, it } from 'vitest';

import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { ControlEventType, createControlPlaneService } from '../../../src/control-plane/index.js';
import { FakeClock, SequentialIds } from '../../e2e/support/world.js';

it('records dispatch pause and resume facts and reflects the durable dispatch state', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const service = createControlPlaneService({ journal, clock, ids: new SequentialIds() });

  expect(await service.isDispatchPaused()).toBe(false);
  await service.pauseDispatch('operator-pause');
  await service.pauseDispatch('operator-pause');
  await service.pauseDispatch('another-operator-pause');

  expect(await service.isDispatchPaused()).toBe(true);
  await service.resumeDispatch('operator-resume');
  expect(await service.isDispatchPaused()).toBe(false);

  const events = await journal.readAll(0);
  expect(events.map((event) => event.event.eventType)).toEqual([
    ControlEventType.DispatchPaused,
    ControlEventType.DispatchResumed,
  ]);
  expect(events[0]?.event).toMatchObject({
    correlationId: 'control:pause-dispatch:operator-pause',
    payload: { resumeAt: '9999-12-31T23:59:59.999Z', reason: 'paused by operator' },
  });
  expect(events[1]?.event).toMatchObject({
    correlationId: 'control:resume-dispatch:operator-resume',
    payload: { resumedAt: clock.now().toISOString() },
  });
});

it('durably deduplicates a dispatch resume after recreating the service', async () => {
  const clock = new FakeClock();
  const journal = new InMemoryEventJournal(clock);
  const input = { journal, clock, ids: new SequentialIds() };
  const first = createControlPlaneService(input);

  await first.pauseDispatch('operator-pause');
  await first.resumeDispatch('operator-resume');

  const restarted = createControlPlaneService({ ...input, ids: new SequentialIds() });
  await restarted.resumeDispatch('operator-resume');

  expect((await journal.readAll(0)).map((event) => event.event.eventType)).toEqual([
    ControlEventType.DispatchPaused,
    ControlEventType.DispatchResumed,
  ]);
});
