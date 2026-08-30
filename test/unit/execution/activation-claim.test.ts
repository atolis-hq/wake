import { describe, expect, it } from 'vitest';
import { activationId } from '../../../src/activities/index.js';
import {
  claimActivation,
  releaseActivation,
} from '../../../src/execution/application/activation-claim.js';
import {
  activationStream,
  decodeActivationExecutionEvent,
  ExecutionEventType,
  runId,
} from '../../../src/execution/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

const config = {
  runnerPools: { standard: ['fake'] },
  defaultRunnerPool: 'standard',
  leaseDurationMs: 60_000,
} as const;

describe('activation claims', () => {
  it('records typed claim and release events and permits a later claim', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const activation = activationId('activation-1');

    await claimActivation({
      journal,
      clock,
      config,
      activationId: activation,
      runId: runId('run-1'),
      owner: 'resident-a',
      occurredAt: clock.now().toISOString(),
    });
    await expect(
      claimActivation({
        journal,
        clock,
        config,
        activationId: activation,
        runId: runId('run-2'),
        owner: 'resident-b',
        occurredAt: clock.now().toISOString(),
      }),
    ).rejects.toThrow(/already has an active Run claim/i);

    await releaseActivation({
      journal,
      clock,
      activationId: activation,
      runId: runId('run-1'),
    });
    await claimActivation({
      journal,
      clock,
      config,
      activationId: activation,
      runId: runId('run-2'),
      owner: 'resident-b',
      occurredAt: clock.now().toISOString(),
    });

    const events = (await journal.readStream(activationStream(activation))).map(
      decodeActivationExecutionEvent,
    );
    expect(events.map((event) => event.event.eventType)).toEqual([
      ExecutionEventType.ActivationClaimed,
      ExecutionEventType.ActivationReleased,
      ExecutionEventType.ActivationClaimed,
    ]);
    expect(events[0]?.event.payload).toEqual({
      runId: runId('run-1'),
      owner: 'resident-a',
      expiresAt: '2026-07-30T12:01:00.000Z',
    });
  });

  it('permits a new claim after the prior claim expires', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const activation = activationId('activation-1');
    await claimActivation({
      journal,
      clock,
      config,
      activationId: activation,
      runId: runId('run-1'),
      owner: 'resident-a',
      occurredAt: clock.now().toISOString(),
    });

    clock.advance(60_001);

    await expect(
      claimActivation({
        journal,
        clock,
        config,
        activationId: activation,
        runId: runId('run-2'),
        owner: 'resident-b',
        occurredAt: clock.now().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });
});
