import { describe, expect, it } from 'vitest';
import { DispatchPolicy } from '../../../src/control-plane/index.js';

const candidate = (overrides: Partial<Parameters<DispatchPolicy['select']>[0][number]> = {}) => ({
  workItemId: overrides.workItemId ?? 'work-a',
  activationId: overrides.activationId ?? 'activation-a',
  requestedPosition: overrides.requestedPosition ?? 1,
  priority: overrides.priority ?? { remainingAgentSteps: 1, watchDriven: false, retried: false },
  hasActiveRun: overrides.hasActiveRun ?? false,
  cancelled: overrides.cancelled ?? false,
});

describe('DispatchPolicy', () => {
  it('selects the oldest eligible activation when priorities tie', () => {
    const policy = new DispatchPolicy({ maxDispatches: 2 });

    expect(
      policy.select([
        candidate({ workItemId: 'a', activationId: 'late', requestedPosition: 4 }),
        candidate({ workItemId: 'b', activationId: 'early', requestedPosition: 2 }),
        candidate({ workItemId: 'a', activationId: 'early', requestedPosition: 1 }),
      ]),
    ).toEqual([
      expect.objectContaining({ activationId: 'early', workItemId: 'a' }),
      expect.objectContaining({ activationId: 'early', workItemId: 'b' }),
    ]);
  });

  it('enforces one active Run per WorkItem and a global dispatch limit', () => {
    const policy = new DispatchPolicy({ maxDispatches: 1 });

    expect(
      policy.select([
        candidate({
          workItemId: 'a',
          activationId: 'active',
          requestedPosition: 1,
          hasActiveRun: true,
        }),
        candidate({ workItemId: 'b', activationId: 'ready', requestedPosition: 2 }),
        candidate({ workItemId: 'c', activationId: 'later', requestedPosition: 3 }),
      ]),
    ).toEqual([expect.objectContaining({ workItemId: 'b', activationId: 'ready' })]);
  });

  describe('priority', () => {
    const policy = new DispatchPolicy({ maxDispatches: 10 });
    const base = { remainingAgentSteps: 2, watchDriven: false, retried: false };
    const order = (...candidates: ReturnType<typeof candidate>[]) =>
      policy.select(candidates).map(({ activationId }) => activationId);

    it('prefers fewer remaining agent steps over every other rule', () => {
      expect(
        order(
          candidate({
            activationId: 'old-watch-retry',
            requestedPosition: 0,
            priority: { remainingAgentSteps: 3, watchDriven: true, retried: true },
          }),
          candidate({
            activationId: 'near',
            requestedPosition: 9,
            priority: { ...base, remainingAgentSteps: 1 },
          }),
        ),
      ).toEqual(['near', 'old-watch-retry']);
    });

    it('prefers watch-driven over retried and over position at equal cost', () => {
      expect(
        order(
          candidate({
            activationId: 'retry',
            requestedPosition: 0,
            priority: { ...base, retried: true },
          }),
          candidate({
            activationId: 'watch',
            requestedPosition: 5,
            priority: { ...base, watchDriven: true },
          }),
        ),
      ).toEqual(['watch', 'retry']);
    });

    it('prefers retried over a first run at equal cost and watch state', () => {
      expect(
        order(
          candidate({ activationId: 'fresh', requestedPosition: 0, priority: base }),
          candidate({
            activationId: 'retry',
            requestedPosition: 5,
            priority: { ...base, retried: true },
          }),
        ),
      ).toEqual(['retry', 'fresh']);
    });

    it('falls back to requestedPosition then activationId on equal priority', () => {
      expect(
        order(
          candidate({ activationId: 'b', requestedPosition: 2, priority: base }),
          candidate({ activationId: 'z', requestedPosition: 1, priority: base }),
          candidate({ activationId: 'a', requestedPosition: 2, priority: base }),
        ),
      ).toEqual(['z', 'a', 'b']);
    });
  });

  it('excludes cancelled activations and a globally blocked dispatch', () => {
    const policy = new DispatchPolicy({ maxDispatches: 3 });

    expect(
      policy.select(
        [candidate({ cancelled: true }), candidate({ workItemId: 'b', activationId: 'ready' })],
        { blocked: true },
      ),
    ).toEqual([]);
  });
});

it('excludes cancelled and running candidates even when they have highest priority', () => {
  const priority = { remainingAgentSteps: 0, watchDriven: true, retried: true };
  expect(
    new DispatchPolicy({ maxDispatches: 3 })
      .select([
        candidate({ activationId: 'cancelled', cancelled: true, priority }),
        candidate({ activationId: 'running', hasActiveRun: true, priority }),
        candidate({ activationId: 'ready' }),
      ])
      .map((item) => item.activationId),
  ).toEqual(['ready']);
});
