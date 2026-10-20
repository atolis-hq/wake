import { expect, it, vi } from 'vitest';
import { DeferredSignals } from '../../../src/orchestration/application/deferred-signals.js';

function subject(deferredIds: readonly string[], fenced: ReadonlySet<string>) {
  const history = vi.fn(async (_id: string) => ({ events: [] }));
  const repository = {
    instancesWithDeferredSignals: async () => new Set(deferredIds),
    history,
    loadRequired: async () => ({ view: {}, sequence: 0 }),
  };
  const fencedAmong = vi.fn(
    async (ids: readonly string[]) => new Set(ids.filter((id) => fenced.has(id))),
  );
  const signals = new DeferredSignals(
    repository as never,
    vi.fn() as never,
    vi.fn() as never,
    fencedAmong as never,
  );
  return { signals, history, fencedAmong };
}

it('reconciles only workflows holding a deferred signal, with one fence check for all of them', async () => {
  const ids = Array.from({ length: 40 }, (_, index) => `workflow-${index}`);
  const { signals, history, fencedAmong } = subject(ids, new Set(['workflow-3', 'workflow-9']));

  await signals.reconcile({} as never);

  expect(fencedAmong).toHaveBeenCalledOnce();
  expect(fencedAmong.mock.calls[0]![0]).toEqual(ids);
  expect(history).toHaveBeenCalledTimes(38);
  expect(history.mock.calls.map(([id]) => id)).not.toContain('workflow-3');
});

it('does nothing when no workflow ever deferred a signal', async () => {
  const { signals, history, fencedAmong } = subject([], new Set());

  await signals.reconcile({} as never);

  expect(fencedAmong).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
});
